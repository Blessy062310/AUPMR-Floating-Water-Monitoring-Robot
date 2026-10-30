/* ==========================================================================
   SMART SUBMARINE MISSION CONTROL · ADVANCED INTERACTION ENGINE
   Bluetooth LE · Three.js 3D Submarine · Underwater Canvas · 3D Tilt HUD
   ========================================================================== */

const $ = id => document.getElementById(id);

// --------------------------------------------------------------------------
// 1. HARDWARE CONSTANTS & STATE (Nordic UART Service for ESP32)
// --------------------------------------------------------------------------
const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const speedSlider = $('speedSlider');
let bleDevice = null, bleServer = null, rxCharacteristic = null, txCharacteristic = null;
let connected = false, activeDirection = 'stop', commandTimer = null;
let lastDirectionLogged = '';
const textDecoder = new TextDecoder();

// Simulation mode state (for testing UI/gauges when hardware is not linked)
let simulationActive = false;
let simInterval = null;

// --------------------------------------------------------------------------
// 2. LOGGING, TOASTS & CONNECTION STATUS
// --------------------------------------------------------------------------
function logEvent(message, label = 'INFO') {
  const log = $('eventLog');
  if (!log) return;
  const row = document.createElement('div');
  row.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = label === 'INFO' ? new Date().toLocaleTimeString() : label;
  const msg = document.createElement('span');
  msg.textContent = message;
  row.append(time, msg);
  log.prepend(row);
  while (log.children.length > 8) log.removeChild(log.lastChild);
}

function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function setConnection(ok) {
  connected = ok;
  const pill = $('connectionPill');
  if (pill) pill.classList.toggle('connected', ok);
  
  const connText = $('connectionText');
  if (connText) connText.textContent = ok ? 'BLUETOOTH CONNECTED' : 'BLUETOOTH DISCONNECTED';
  
  const connectBtn = $('connectButton');
  if (connectBtn) {
    const textSpan = connectBtn.querySelector('.btn-text');
    if (textSpan) textSpan.textContent = ok ? 'DISCONNECT BLUETOOTH' : 'CONNECT BLUETOOTH';
    else connectBtn.textContent = ok ? 'DISCONNECT BLUETOOTH' : 'CONNECT BLUETOOTH';
  }

  const ctrlState = $('controllerState');
  if (ctrlState) {
    ctrlState.textContent = ok ? 'BLE ONLINE (GATT)' : 'OFFLINE';
    ctrlState.className = ok ? 'safe-text' : 'hud-state-offline';
  }

  if (!ok && !simulationActive) {
    const sys = $('systemState');
    if (sys) sys.textContent = 'OFFLINE';
  }
}

// --------------------------------------------------------------------------
// 3. MOTOR PROPULSION RENDERING
// --------------------------------------------------------------------------
function renderMotor(direction, speed) {
  activeDirection = direction || 'stop';
  const dirVal = $('directionValue');
  if (dirVal) dirVal.textContent = activeDirection.toUpperCase();
  
  const powVal = $('powerValue');
  if (powVal) powVal.textContent = `${speed}%`;
  
  const powBar = $('powerBar');
  if (powBar) powBar.style.width = `${speed}%`;
  
  const sysState = $('systemState');
  if (sysState) sysState.textContent = activeDirection === 'stop' ? 'STANDBY' : 'PROPULSION ACTIVE';
  
  // Highlight active direction button
  document.querySelectorAll('.drive-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.direction === activeDirection);
  });

  // Motor Core Animation
  const motorCore = $('motorCoreVisual');
  const motorInner = $('motorInnerSpin');
  const motorRpm = $('motorRpmTag');
  
  if (activeDirection !== 'stop' && speed > 0) {
    if (motorCore) motorCore.classList.add('active');
    if (motorInner) motorInner.classList.add('spinning');
    const calcRpm = Math.round(speed * 32);
    if (motorRpm) motorRpm.textContent = `${calcRpm} RPM`;
    const hudThruster = $('hudThrusterText');
    if (hudThruster) hudThruster.textContent = `THRUST: ${activeDirection.toUpperCase()} · ${calcRpm} RPM`;
    if (window.sub3d) window.sub3d.setPropellerSpeed(speed * 0.4);
  } else {
    if (motorCore) motorCore.classList.remove('active');
    if (motorInner) motorInner.classList.remove('spinning');
    if (motorRpm) motorRpm.textContent = '0 RPM';
    const hudThruster = $('hudThrusterText');
    if (hudThruster) hudThruster.textContent = 'IDLE · 0 RPM';
    if (window.sub3d) window.sub3d.setPropellerSpeed(0.04);
  }

  // Update slider fill bar
  const sliderFill = $('sliderFillBar');
  if (sliderFill && speedSlider) {
    sliderFill.style.width = `${speedSlider.value}%`;
  }

  // Event logging
  if (activeDirection !== lastDirectionLogged) {
    if (activeDirection !== 'stop') {
      logEvent(`Motor vector: ${activeDirection.toUpperCase()} at ${speed}% power.`, 'MOTOR');
    } else if (lastDirectionLogged) {
      logEvent('Motor thrusters halted.', 'MOTOR');
    }
    lastDirectionLogged = activeDirection;
  }
}

// --------------------------------------------------------------------------
// 4. TELEMETRY & ANIMATED GAUGES PARSER
// --------------------------------------------------------------------------
const GAUGE_MAX_DASH = 142; // SVG circular path length for arc of 142

function setGaugeProgress(pathId, normalizedRatio) {
  const path = $(pathId);
  if (!path) return;
  const clamped = Math.max(0, Math.min(1, normalizedRatio));
  const offset = GAUGE_MAX_DASH * (1 - clamped);
  path.style.strokeDashoffset = offset;
}

function showValue(id, value, unit, decimals = 1) {
  const el = $(id);
  if (!el) return;
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    el.innerHTML = `--<small> ${unit}</small>`;
  } else {
    el.innerHTML = `${Number(value).toFixed(decimals)}<small> ${unit}</small>`;
  }
}

function parseMaybeNumber(value) {
  if (value === undefined || value === null || value === '' || value === 'x' || value === 'null') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function handleTelemetry(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return;
  const type = line.slice(0, colon).trim();
  const values = line.slice(colon + 1).trim().split(',');

  if (type === 'M') {
    // Motor telemetry: M:direction,speed
    renderMotor(values[0] || 'stop', Math.max(0, Math.min(100, Number(values[1]) || 0)));
  } else if (type === 'P') {
    // pH sensor: P:ph,voltage
    const phVal = parseMaybeNumber(values[0]);
    showValue('phValue', phVal, 'pH', 2);
    if (phVal !== null) {
      setGaugeProgress('phGaugePath', phVal / 14);
    }
    const phVolt = parseMaybeNumber(values[1]);
    const voltEl = $('phVoltage');
    if (voltEl) voltEl.textContent = phVolt === null ? '-- V input' : `${Number(phVolt).toFixed(2)} V input`;
    const phSt = $('phState');
    if (phSt) phSt.textContent = phVal === null ? 'CHECK SENSOR' : 'LIVE';
  } else if (type === 'T') {
    // Temperature sensor: T:temperature
    const n = parseMaybeNumber(values[0]);
    showValue('tempValue', n, '°C', 1);
    if (n !== null) {
      setGaugeProgress('tempGaugePath', Math.max(0, (n - 0) / 50));
    }
    const tempSt = $('tempState');
    if (tempSt) tempSt.textContent = n === null ? 'NO SENSOR' : 'LIVE';
  } else if (type === 'U') {
    // Turbidity sensor: U:voltage
    const n = parseMaybeNumber(values[0]);
    showValue('turbidityValue', n, 'V', 2);
    if (n !== null) {
      setGaugeProgress('turbidityGaugePath', n / 5.0);
    }
    const turbSt = $('turbidityState');
    if (turbSt) turbSt.textContent = n === null ? 'CHECK SENSOR' : 'LIVE';
  } else if (type === 'D') {
    // Depth sensor: D:depth_meters
    const n = parseMaybeNumber(values[0]);
    showValue('depthValue', n, 'm', 2);
    if (n !== null) {
      setGaugeProgress('depthGaugePath', n / 25.0);
    }
    const dSt = $('depthState');
    if (dSt) dSt.textContent = n === null ? 'SETUP' : 'LIVE';
  } else if (type === 'B') {
    // Battery sensor: B:voltage
    const n = parseMaybeNumber(values[0]);
    showValue('batteryValue', n, 'V', 2);
    if (n !== null) {
      const pct = Math.max(0, Math.min(100, Math.round(((n - 10.5) / (12.6 - 10.5)) * 100)));
      setGaugeProgress('batteryGaugePath', pct / 100);
      const batLbl = $('batteryPercentLabel');
      if (batLbl) batLbl.textContent = `${pct}% Capacity (${n.toFixed(1)}V)`;
    }
    const bSt = $('batteryState');
    if (bSt) bSt.textContent = n === null ? 'SETUP' : 'LIVE';
  } else if (type === 'L') {
    // Leak detection: L:0 or L:1
    const leakVal = $('leakValue');
    const leakSt = $('leakState');
    const leakRing = $('leakPulseRing');
    
    if (values[0] === 'x') {
      if (leakVal) { leakVal.textContent = 'NOT CONFIGURED'; leakVal.style.color = 'var(--text-dim)'; }
      if (leakSt) leakSt.textContent = 'SETUP';
      if (leakRing) leakRing.classList.remove('alert');
    } else {
      const leak = values[0] === '1';
      if (leakVal) {
        leakVal.textContent = leak ? 'MOISTURE DETECTED!' : 'HULL DRY / SEALED';
        leakVal.style.color = leak ? 'var(--red)' : 'var(--green)';
      }
      if (leakSt) {
        leakSt.textContent = leak ? 'ALARM' : 'SAFE';
      }
      if (leakRing) {
        leakRing.classList.toggle('alert', leak);
      }
      if (leak && activeDirection !== 'stop') {
        stopDrive();
        toast('LEAK ALARM DETECTED — EMERGENCY HALT TRIGGERED');
        logEvent('CRITICAL: Moisture detected in electronics hull!', 'LEAK');
      }
    }
  }

  const updatedEl = $('lastUpdated');
  if (updatedEl) updatedEl.textContent = new Date().toLocaleTimeString();
}

// --------------------------------------------------------------------------
// 5. BLUETOOTH COMMAND DISPATCHER & CONTROL
// --------------------------------------------------------------------------
async function writeCommand(direction = activeDirection) {
  if (!connected || !rxCharacteristic) return false;
  if (direction === 'left' || direction === 'right') {
    toast('Port/Starboard differential turning requires auxiliary steering thruster.');
    return false;
  }
  const speed = Math.max(0, Math.min(100, Number(speedSlider.value) || 0));
  let command = 'S,0';
  if (direction === 'forward' && speed > 0) command = `F,${speed}`;
  if (direction === 'reverse' && speed > 0) command = `R,${speed}`;

  try {
    const bytes = new TextEncoder().encode(command);
    if (rxCharacteristic.writeValueWithResponse) {
      await rxCharacteristic.writeValueWithResponse(bytes);
    } else {
      await rxCharacteristic.writeValue(bytes);
    }
    if (direction === 'stop' || speed === 0) renderMotor('stop', 0);
    return true;
  } catch (err) {
    toast('BLE command transmission error. Verify link status.');
    return false;
  }
}

function beginDrive(direction) {
  if (direction === 'left' || direction === 'right') {
    toast('Port/Starboard turning requires auxiliary dual thrusters.');
    logEvent(`${direction.toUpperCase()} vector unavailable with single propulsion unit.`, 'LIMIT');
    return;
  }
  if (!connected && !simulationActive) {
    toast('Connect Bluetooth first or toggle Simulation Mode.');
    return;
  }
  if (Number(speedSlider.value) <= 0) {
    toast('Advance thrust power slider before firing motor.');
    return;
  }

  clearInterval(commandTimer);
  activeDirection = direction;
  
  if (connected) {
    writeCommand(direction);
    commandTimer = setInterval(() => writeCommand(direction), 300);
  } else if (simulationActive) {
    renderMotor(direction, Number(speedSlider.value));
  }
}

function stopDrive() {
  clearInterval(commandTimer);
  commandTimer = null;
  if (connected) {
    writeCommand('stop');
  }
  activeDirection = 'stop';
  renderMotor('stop', 0);
  document.querySelectorAll('.drive-btn').forEach(btn => btn.classList.remove('active'));
}

function onBleDisconnected() {
  clearInterval(commandTimer);
  commandTimer = null;
  connected = false;
  rxCharacteristic = null;
  txCharacteristic = null;
  bleServer = null;
  setConnection(false);
  renderMotor('stop', 0);
  logEvent('Bluetooth link closed. Failsafe timeout locked motor.', 'WARN');
  toast('Bluetooth disconnected.');
}

async function connectBluetooth() {
  if (!('bluetooth' in navigator)) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      toast('iOS Safari lacks Web Bluetooth. Open this page in the free "Bluefy" browser app.');
      logEvent('iOS Safari does not support Web Bluetooth. Use the Bluefy browser from the App Store.', 'ALERT');
    } else {
      toast('Web Bluetooth unavailable. Use Chrome or Edge on Android / Desktop over HTTPS.');
      logEvent('Web Bluetooth requires Chrome or Edge on HTTPS/localhost.', 'WARN');
    }
    return;
  }
  
  const connBtn = $('connectButton');
  if (connBtn) {
    connBtn.disabled = true;
    const txt = connBtn.querySelector('.btn-text');
    if (txt) txt.textContent = 'SCANNING BLE…';
  }

  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'SmartSubmarine' }],
      optionalServices: [SERVICE_UUID]
    });
    
    bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
    bleServer = await bleDevice.gatt.connect();
    const service = await bleServer.getPrimaryService(SERVICE_UUID);
    rxCharacteristic = await service.getCharacteristic(RX_UUID);
    txCharacteristic = await service.getCharacteristic(TX_UUID);
    await txCharacteristic.startNotifications();
    
    txCharacteristic.addEventListener('characteristicvaluechanged', event => {
      const value = event.target.value;
      const line = textDecoder.decode(value).trim();
      if (line) handleTelemetry(line);
    });

    setConnection(true);
    const ip = $('ipAddress');
    if (ip) ip.textContent = 'BLE · SmartSubmarine';
    logEvent('GATT link established with SmartSubmarine.', 'BLE');
    toast('Connected to SmartSubmarine via Bluetooth LE.');
    
    // Auto disable simulation if active
    if (simulationActive) toggleSimulation(false);
  } catch (err) {
    console.error(err);
    setConnection(false);
    toast(err.name === 'NotFoundError' ? 'No device chosen. Select SmartSubmarine.' : 'Bluetooth link failed. Verify ESP32 power.');
  } finally {
    if (connBtn) {
      connBtn.disabled = false;
      const txt = connBtn.querySelector('.btn-text');
      if (txt) txt.textContent = connected ? 'DISCONNECT BLUETOOTH' : 'CONNECT BLUETOOTH';
    }
  }
}

$('connectButton')?.addEventListener('click', async () => {
  if (connected && bleDevice?.gatt?.connected) {
    stopDrive();
    try { bleDevice.gatt.disconnect(); } catch (_) {}
    onBleDisconnected();
  } else {
    await connectBluetooth();
  }
});

// --------------------------------------------------------------------------
// 6. DIRECTIONAL & EMERGENCY CONTROLS
// --------------------------------------------------------------------------
document.querySelectorAll('.drive-btn').forEach(btn => {
  const direction = btn.dataset.direction;
  
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    beginDrive(direction);
  });
  
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => {
    btn.addEventListener(evt, () => {
      if (activeDirection === direction && (direction === 'forward' || direction === 'reverse')) {
        stopDrive();
      }
    });
  });

  btn.addEventListener('contextmenu', e => e.preventDefault());
});

$('centerStopButton')?.addEventListener('click', () => {
  stopDrive();
  toast('Propulsion Stop packet dispatched.');
});

$('stopButton')?.addEventListener('click', () => {
  stopDrive();
  toast('EMERGENCY ALL-STOP TRIGGERED.');
  logEvent('Emergency Stop Button depressed.', 'STOP');
});

speedSlider?.addEventListener('input', () => {
  const speedVal = $('speedValue');
  if (speedVal) speedVal.textContent = speedSlider.value;
  if ((connected || simulationActive) && activeDirection !== 'stop') {
    if (connected) writeCommand(activeDirection);
    renderMotor(activeDirection, Number(speedSlider.value));
  }
});

window.addEventListener('blur', stopDrive);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopDrive();
});

// --------------------------------------------------------------------------
// 7. CAMERA FEED OPTICAL SUBSYSTEM
// --------------------------------------------------------------------------
const camImg = $('cameraImage'), camVideo = $('cameraVideo');

function clearCameraFeed() {
  if (camImg) {
    camImg.hidden = true;
    camImg.removeAttribute('src');
  }
  if (camVideo) {
    camVideo.pause();
    camVideo.hidden = true;
    camVideo.removeAttribute('src');
    camVideo.load();
  }
  const placeholder = $('cameraPlaceholder');
  if (placeholder) placeholder.hidden = false;
  const status = $('cameraStatus');
  if (status) status.textContent = 'WAITING FOR SOURCE';
}

$('cameraConnect')?.addEventListener('click', () => {
  const input = $('cameraUrl');
  if (!input) return;
  const raw = input.value.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    toast('Enter a valid camera stream URL.');
    return;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    toast('Camera URL must begin with http:// or https://');
    return;
  }

  clearCameraFeed();
  const placeholder = $('cameraPlaceholder');
  if (placeholder) placeholder.hidden = true;
  const status = $('cameraStatus');
  if (status) status.textContent = 'CONNECTING OPTICS…';

  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(url.pathname)) {
    camVideo.hidden = false;
    camVideo.src = url.href;
    camVideo.onloadeddata = () => { if (status) status.textContent = 'OPTICAL FEED ACTIVE'; };
    camVideo.onerror = () => {
      clearCameraFeed();
      if (status) status.textContent = 'OPTICS ERROR';
      toast('Failed to load video stream. Check address.');
    };
    camVideo.play().catch(() => {});
  } else {
    camImg.hidden = false;
    camImg.src = url.href;
    camImg.onload = () => { if (status) status.textContent = 'STREAM CONNECTED'; };
    camImg.onerror = () => {
      clearCameraFeed();
      if (status) status.textContent = 'STREAM ERROR';
      toast('Stream connection refused. Check camera IP.');
    };
  }
});

$('cameraClear')?.addEventListener('click', () => {
  clearCameraFeed();
  const input = $('cameraUrl');
  if (input) input.value = '';
  toast('Optical feed cleared.');
});

// Demo video stream button
$('cameraSampleBtn')?.addEventListener('click', () => {
  const sampleUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  const input = $('cameraUrl');
  if (input) input.value = sampleUrl;
  $('cameraConnect')?.click();
  toast('Loading sample test stream.');
});

// Live camera clock
setInterval(() => {
  const clock = $('cameraTimestamp');
  if (clock) {
    const d = new Date();
    clock.textContent = d.toTimeString().split(' ')[0] + '.' + String(Math.floor(d.getMilliseconds() / 100));
  }
}, 100);

// --------------------------------------------------------------------------
// 8. THREE.JS PROCEDURAL 3D SUBMARINE ENGINE
// --------------------------------------------------------------------------
class Submarine3DViewer {
  constructor(containerId) {
    this.container = $(containerId);
    if (!this.container || typeof THREE === 'undefined') {
      console.warn('Three.js unavailable or container missing; using CSS fallback.');
      return;
    }

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.subGroup = null;
    this.propellerMesh = null;
    this.spotlights = [];
    this.lightsOn = true;
    this.particles = null;

    // Orientation & Interpolation
    this.targetRotationX = -0.15;
    this.targetRotationY = -0.35;
    this.currentRotationX = -0.15;
    this.currentRotationY = -0.35;
    
    // Drag interaction
    this.isDragging = false;
    this.previousPointerPosition = { x: 0, y: 0 };
    this.autoRotate = false;
    this.propellerSpeed = 0.04;
    this.clock = new THREE.Clock();

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 600;
    const height = this.container.clientHeight || 360;

    // Scene with oceanic fog
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x061825, 0.035);

    // Camera
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    this.camera.position.set(0, 0.8, 6.2);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);

    // Hide fallback CSS model
    const cssSub = $('submarineModel');
    if (cssSub) cssSub.style.display = 'none';

    // Build Submarine Model & Underwater Environment
    this.createLights();
    this.createSubmarineModel();
    this.createMarineSnow();
    this.bindEvents();

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  createLights() {
    // Ambient abyssal light
    const ambientLight = new THREE.AmbientLight(0x194b63, 1.4);
    this.scene.add(ambientLight);

    // Main volumetric overhead light
    const dirLight = new THREE.DirectionalLight(0x7df6ec, 2.0);
    dirLight.position.set(4, 8, 5);
    this.scene.add(dirLight);

    // Deep ocean rim backlight
    const rimLight = new THREE.DirectionalLight(0x2876a3, 1.2);
    rimLight.position.set(-6, -4, -4);
    this.scene.add(rimLight);
  }

  createSubmarineModel() {
    this.subGroup = new THREE.Group();

    // High tech metallic hull materials
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0x1f5c72,
      metalness: 0.65,
      roughness: 0.35,
    });

    const darkHullMaterial = new THREE.MeshStandardMaterial({
      color: 0x0c2738,
      metalness: 0.7,
      roughness: 0.4,
    });

    const brassMaterial = new THREE.MeshStandardMaterial({
      color: 0xd9a441,
      metalness: 0.9,
      roughness: 0.25,
    });

    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x66ffff,
      metalness: 0.1,
      roughness: 0.1,
      transmission: 0.85,
      transparent: true,
      opacity: 0.85,
      ior: 1.4,
    });

    // 1. Central Torpedo Body Hull
    const hullGeom = new THREE.CylinderGeometry(0.55, 0.48, 3.2, 32);
    hullGeom.rotateZ(Math.PI / 2);
    const mainHull = new THREE.Mesh(hullGeom, hullMaterial);
    this.subGroup.add(mainHull);

    // 2. Hemispherical Nose (Bow)
    const noseGeom = new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    noseGeom.rotateZ(-Math.PI / 2);
    const noseMesh = new THREE.Mesh(noseGeom, hullMaterial);
    noseMesh.position.set(1.6, 0, 0);
    this.subGroup.add(noseMesh);

    // 3. Forward Acrylic Observation Dome (Cockpit Window)
    const domeGeom = new THREE.SphereGeometry(0.38, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    domeGeom.rotateZ(-Math.PI / 2);
    const domeMesh = new THREE.Mesh(domeGeom, glassMaterial);
    domeMesh.position.set(1.85, 0.05, 0);
    this.subGroup.add(domeMesh);

    // Interior Cockpit Glow Point
    const cockpitLight = new THREE.PointLight(0x35e0d0, 1.2, 1.5);
    cockpitLight.position.set(1.7, 0.05, 0);
    this.subGroup.add(cockpitLight);

    // 4. Conning Tower / Sail
    const towerGeom = new THREE.CylinderGeometry(0.22, 0.26, 0.65, 16);
    towerGeom.scale(1.8, 1, 0.8);
    const towerMesh = new THREE.Mesh(towerGeom, darkHullMaterial);
    towerMesh.position.set(0.3, 0.72, 0);
    this.subGroup.add(towerMesh);

    // Periscope & Sensor Mast
    const mastGeom = new THREE.CylinderGeometry(0.03, 0.03, 0.45, 12);
    const mastMesh = new THREE.Mesh(mastGeom, brassMaterial);
    mastMesh.position.set(0.45, 1.15, 0);
    this.subGroup.add(mastMesh);

    // 5. Dive Planes / Hydroplane Fins (Port & Starboard)
    const finGeom = new THREE.BoxGeometry(0.45, 0.04, 0.55);
    const finLeft = new THREE.Mesh(finGeom, darkHullMaterial);
    finLeft.position.set(0.3, 0.7, 0.45);
    finLeft.rotation.x = 0.05;
    this.subGroup.add(finLeft);

    const finRight = new THREE.Mesh(finGeom, darkHullMaterial);
    finRight.position.set(0.3, 0.7, -0.45);
    finRight.rotation.x = -0.05;
    this.subGroup.add(finRight);

    // 6. Tapered Stern & Rudder Section
    const sternGeom = new THREE.ConeGeometry(0.48, 0.9, 32);
    sternGeom.rotateZ(Math.PI / 2);
    const sternMesh = new THREE.Mesh(sternGeom, hullMaterial);
    sternMesh.position.set(-2.0, 0, 0);
    this.subGroup.add(sternMesh);

    // Cruciform Rudders (Vertical & Horizontal)
    const rudderVertGeom = new THREE.BoxGeometry(0.5, 1.1, 0.04);
    const rudderVert = new THREE.Mesh(rudderVertGeom, darkHullMaterial);
    rudderVert.position.set(-2.25, 0, 0);
    this.subGroup.add(rudderVert);

    const rudderHorizGeom = new THREE.BoxGeometry(0.5, 0.04, 1.1);
    const rudderHoriz = new THREE.Mesh(rudderHorizGeom, darkHullMaterial);
    rudderHoriz.position.set(-2.25, 0, 0);
    this.subGroup.add(rudderHoriz);

    // 7. Rotating Brass Propeller Assembly
    this.propellerMesh = new THREE.Group();
    const propHubGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.22, 16);
    propHubGeom.rotateZ(Math.PI / 2);
    const propHub = new THREE.Mesh(propHubGeom, brassMaterial);
    this.propellerMesh.add(propHub);

    // 4 Propeller Blades
    for (let i = 0; i < 4; i++) {
      const bladeGeom = new THREE.BoxGeometry(0.02, 0.42, 0.12);
      bladeGeom.rotateX(0.35);
      const blade = new THREE.Mesh(bladeGeom, brassMaterial);
      blade.rotation.x = (i * Math.PI) / 2;
      this.propellerMesh.add(blade);
    }
    this.propellerMesh.position.set(-2.55, 0, 0);
    this.subGroup.add(this.propellerMesh);

    // 8. High-Intensity Front Spotlights
    const spotGeom = new THREE.CylinderGeometry(0.08, 0.11, 0.18, 16);
    spotGeom.rotateZ(Math.PI / 2);
    
    // Left Spotlight
    const spotL = new THREE.Mesh(spotGeom, brassMaterial);
    spotL.position.set(1.4, -0.2, 0.42);
    this.subGroup.add(spotL);

    const lightConeL = new THREE.SpotLight(0x99ffff, 3.5, 12, Math.PI / 6, 0.4, 1.5);
    lightConeL.position.set(1.5, -0.2, 0.42);
    lightConeL.target.position.set(6, -0.4, 0.6);
    this.subGroup.add(lightConeL);
    this.subGroup.add(lightConeL.target);
    this.spotlights.push(lightConeL);

    // Right Spotlight
    const spotR = new THREE.Mesh(spotGeom, brassMaterial);
    spotR.position.set(1.4, -0.2, -0.42);
    this.subGroup.add(spotR);

    const lightConeR = new THREE.SpotLight(0x99ffff, 3.5, 12, Math.PI / 6, 0.4, 1.5);
    lightConeR.position.set(1.5, -0.2, -0.42);
    lightConeR.target.position.set(6, -0.4, -0.6);
    this.subGroup.add(lightConeR);
    this.subGroup.add(lightConeR.target);
    this.spotlights.push(lightConeR);

    // 9. Navigation LED Beacon Lights
    // Port (Red)
    const navRedLight = new THREE.PointLight(0xff3355, 1.0, 1.2);
    navRedLight.position.set(0.3, 0.72, 0.68);
    this.subGroup.add(navRedLight);

    // Starboard (Green)
    const navGreenLight = new THREE.PointLight(0x33ff88, 1.0, 1.2);
    navGreenLight.position.set(0.3, 0.72, -0.68);
    this.subGroup.add(navGreenLight);

    // Mast Top Beacon (Amber)
    const mastBeacon = new THREE.PointLight(0xffbe53, 1.2, 1.5);
    mastBeacon.position.set(0.45, 1.4, 0);
    this.subGroup.add(mastBeacon);

    this.scene.add(this.subGroup);
  }

  createMarineSnow() {
    const particleCount = 180;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount * 3; i += 3) {
      positions[i] = (Math.random() - 0.5) * 14;
      positions[i + 1] = (Math.random() - 0.5) * 8;
      positions[i + 2] = (Math.random() - 0.5) * 10;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x48e5d6,
      size: 0.045,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(geom, mat);
    this.scene.add(this.particles);
  }

  bindEvents() {
    const stage = $('subVisual');
    if (!stage) return;

    // Pointer move tilts the submarine smoothly
    stage.addEventListener('pointermove', e => {
      if (this.isDragging) {
        const deltaX = e.clientX - this.previousPointerPosition.x;
        const deltaY = e.clientY - this.previousPointerPosition.y;
        this.targetRotationY += deltaX * 0.012;
        this.targetRotationX += deltaY * 0.012;
        this.previousPointerPosition = { x: e.clientX, y: e.clientY };
      } else {
        const rect = stage.getBoundingClientRect();
        const normX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
        const normY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
        this.targetRotationY = -0.35 + normX * 0.65;
        this.targetRotationX = -0.15 - normY * 0.45;
      }
    });

    stage.addEventListener('pointerdown', e => {
      this.isDragging = true;
      this.previousPointerPosition = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('pointerup', () => {
      this.isDragging = false;
    });

    stage.addEventListener('pointerleave', () => {
      if (!this.isDragging) {
        this.targetRotationX = -0.15;
        this.targetRotationY = -0.35;
      }
    });

    // Window Resize
    window.addEventListener('resize', () => {
      if (!this.container || !this.renderer || !this.camera) return;
      const width = this.container.clientWidth || 600;
      const height = this.container.clientHeight || 360;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });

    // Toolbar buttons
    $('resetSubViewBtn')?.addEventListener('click', () => {
      this.targetRotationX = -0.15;
      this.targetRotationY = -0.35;
      this.autoRotate = false;
      $('autoRotateSubBtn')?.classList.remove('active');
      toast('Orientation reset to neutral.');
    });

    $('toggleLightsBtn')?.addEventListener('click', () => {
      this.lightsOn = !this.lightsOn;
      this.spotlights.forEach(spot => (spot.visible = this.lightsOn));
      $('toggleLightsBtn')?.classList.toggle('active', this.lightsOn);
      toast(this.lightsOn ? 'High-beam searchlights ON.' : 'Searchlights OFF.');
    });

    $('autoRotateSubBtn')?.addEventListener('click', () => {
      this.autoRotate = !this.autoRotate;
      $('autoRotateSubBtn')?.classList.toggle('active', this.autoRotate);
    });
  }

  setPropellerSpeed(speed) {
    this.propellerSpeed = speed;
  }

  animate() {
    requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    if (this.autoRotate) {
      this.targetRotationY += 0.008;
    }

    // Smooth inertia lerping
    this.currentRotationX += (this.targetRotationX - this.currentRotationX) * 0.08;
    this.currentRotationY += (this.targetRotationY - this.currentRotationY) * 0.08;

    if (this.subGroup) {
      // Natural underwater buoyancy float
      const buoyancyPitch = Math.sin(elapsed * 1.2) * 0.04;
      const buoyancyRoll = Math.cos(elapsed * 0.9) * 0.03;
      const buoyancyBob = Math.sin(elapsed * 1.5) * 0.08;

      this.subGroup.rotation.x = this.currentRotationX + buoyancyPitch;
      this.subGroup.rotation.y = this.currentRotationY + buoyancyRoll;
      this.subGroup.position.y = buoyancyBob;

      // Spin propeller
      if (this.propellerMesh) {
        this.propellerMesh.rotation.x += this.propellerSpeed;
      }

      // Update HUD attitude text
      const pitchDeg = Math.round((this.subGroup.rotation.x * 180) / Math.PI);
      const yawDeg = Math.round((this.subGroup.rotation.y * 180) / Math.PI);
      const attitudeEl = $('attitudeText');
      if (attitudeEl) attitudeEl.textContent = `${pitchDeg}° / ${yawDeg}°`;
    }

    // Drift marine snow
    if (this.particles) {
      const positions = this.particles.geometry.attributes.position.array;
      for (let i = 1; i < positions.length; i += 3) {
        positions[i] -= 0.005;
        if (positions[i] < -4) positions[i] = 4;
      }
      this.particles.geometry.attributes.position.needsUpdate = true;
    }

    this.renderer.render(this.scene, this.camera);
  }
}

// --------------------------------------------------------------------------
// 9. UNDERWATER OCEAN BACKGROUND CANVAS (Bubbles, Caustics & Parallax)
// --------------------------------------------------------------------------
class OceanBackground {
  constructor(canvasId) {
    this.canvas = $(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.bubbles = [];
    this.particles = [];
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.targetMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.width = (this.canvas.width = window.innerWidth);
    this.height = (this.canvas.height = window.innerHeight);

    this.init();
  }

  init() {
    this.createElements();
    window.addEventListener('resize', () => {
      this.width = this.canvas.width = window.innerWidth;
      this.height = this.canvas.height = window.innerHeight;
    });

    window.addEventListener('pointermove', e => {
      this.targetMouse.x = e.clientX;
      this.targetMouse.y = e.clientY;
    });

    this.render = this.render.bind(this);
    requestAnimationFrame(this.render);
  }

  createElements() {
    // Rising bubbles
    this.bubbles = [];
    for (let i = 0; i < 35; i++) {
      this.bubbles.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: Math.random() * 4 + 1.5,
        speed: Math.random() * 0.8 + 0.4,
        wobble: Math.random() * Math.PI * 2,
        alpha: Math.random() * 0.4 + 0.1,
      });
    }

    // Glowing marine dust / plankton
    this.particles = [];
    for (let i = 0; i < 60; i++) {
      this.particles.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: Math.random() * 2 + 0.5,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        alpha: Math.random() * 0.6 + 0.2,
      });
    }
  }

  render() {
    requestAnimationFrame(this.render);

    // Mouse parallax lerp
    this.mouse.x += (this.targetMouse.x - this.mouse.x) * 0.04;
    this.mouse.y += (this.targetMouse.y - this.mouse.y) * 0.04;
    const parallaxX = (this.mouse.x / this.width - 0.5) * 35;
    const parallaxY = (this.mouse.y / this.height - 0.5) * 25;

    this.ctx.clearRect(0, 0, this.width, this.height);

    // Draw Subtle Underwater Volumetric Rays
    const grad = this.ctx.createLinearGradient(0, 0, this.width, this.height);
    grad.addColorStop(0, 'rgba(12, 45, 62, 0.4)');
    grad.addColorStop(0.5, 'rgba(6, 25, 38, 0.1)');
    grad.addColorStop(1, 'transparent');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Render & update bubbles
    this.ctx.strokeStyle = 'rgba(53, 224, 208, 0.45)';
    this.ctx.fillStyle = 'rgba(53, 224, 208, 0.12)';
    this.ctx.lineWidth = 1;

    for (let b of this.bubbles) {
      b.y -= b.speed;
      b.wobble += 0.03;
      const wobbleX = b.x + Math.sin(b.wobble) * 8 + parallaxX * 0.4;

      if (b.y < -10) {
        b.y = this.height + 10;
        b.x = Math.random() * this.width;
      }

      this.ctx.beginPath();
      this.ctx.arc(wobbleX, b.y + parallaxY * 0.4, b.r, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.fill();
    }

    // Render glowing marine plankton
    for (let p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x = this.width;
      if (p.x > this.width) p.x = 0;
      if (p.y < 0) p.y = this.height;
      if (p.y > this.height) p.y = 0;

      this.ctx.beginPath();
      this.ctx.arc(p.x + parallaxX * 0.8, p.y + parallaxY * 0.8, p.r, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(53, 224, 208, ${p.alpha})`;
      this.ctx.fill();
    }
  }
}

// --------------------------------------------------------------------------
// 10. INTERACTIVE 3D CARD TILT & SPECULAR GLARE
// --------------------------------------------------------------------------
function init3DCardTilt() {
  const cards = document.querySelectorAll('.tilt-card');

  cards.forEach(card => {
    let bounds;

    function onPointerMove(e) {
      if (e.pointerType && e.pointerType !== 'mouse') return; // Touch scrolling remains smooth
      bounds = card.getBoundingClientRect();
      const mouseX = e.clientX - bounds.left;
      const mouseY = e.clientY - bounds.top;

      const normX = mouseX / bounds.width - 0.5;
      const normY = mouseY / bounds.height - 0.5;

      const maxTilt = Number(card.dataset.tiltMax) || 8;
      const tiltX = -normY * maxTilt;
      const tiltY = normX * maxTilt;

      card.style.transform = `perspective(1000px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translateY(-3px)`;
      card.style.setProperty('--mouse-x', `${mouseX}px`);
      card.style.setProperty('--mouse-y', `${mouseY}px`);
    }

    function onPointerLeave() {
      card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)';
    }

    card.addEventListener('pointermove', onPointerMove, { passive: true });
    card.addEventListener('pointerleave', onPointerLeave);
  });
}

// --------------------------------------------------------------------------
// 11. DEMO & SIMULATION MODE ENGINE
// --------------------------------------------------------------------------
function toggleSimulation(forceState) {
  simulationActive = typeof forceState === 'boolean' ? forceState : !simulationActive;
  const btn = $('simModeButton');
  const txt = $('simModeText');
  
  if (btn) btn.classList.toggle('active', simulationActive);
  if (txt) txt.textContent = simulationActive ? 'SIMULATION: ACTIVE' : 'SIMULATION: OFF';

  clearInterval(simInterval);

  if (simulationActive) {
    toast('Simulation Mode active: Generating simulated telemetry & gauges.');
    logEvent('Simulation Mode active. Testing sensor dynamics.', 'SIM');
    
    const sys = $('systemState');
    if (sys && !connected) sys.textContent = 'SIMULATION RUNNING';

    // Telemetry cycle loop
    let simDepth = 2.4;
    let simTemp = 21.8;
    let simPh = 7.4;
    let simBat = 12.1;
    let simTurb = 3.65;

    simInterval = setInterval(() => {
      simDepth += (Math.random() - 0.49) * 0.15;
      simDepth = Math.max(0.5, Math.min(22, simDepth));

      simTemp += (Math.random() - 0.5) * 0.2;
      simPh += (Math.random() - 0.5) * 0.08;
      simTurb += (Math.random() - 0.5) * 0.05;
      simBat -= 0.001;

      handleTelemetry(`P:${simPh.toFixed(2)},4.12`);
      handleTelemetry(`T:${simTemp.toFixed(1)}`);
      handleTelemetry(`D:${simDepth.toFixed(2)}`);
      handleTelemetry(`U:${simTurb.toFixed(2)}`);
      handleTelemetry(`B:${simBat.toFixed(2)}`);
      handleTelemetry('L:0');
    }, 1200);
  } else {
    toast('Simulation Mode deactivated.');
    logEvent('Simulation Mode stopped.', 'SIM');
    if (!connected) {
      setConnection(false);
    }
  }
}

$('simModeButton')?.addEventListener('click', () => toggleSimulation());

// --------------------------------------------------------------------------
// 12. INITIALIZATION ROUTINE
// --------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Ocean Background Canvas
  new OceanBackground('oceanCanvas');

  // 2. Initialize Three.js Submarine Viewer
  window.sub3d = new Submarine3DViewer('threeCanvasContainer');

  // 3. Initialize 3D Card Hover Tilt
  init3DCardTilt();

  // 4. Initial state
  setConnection(false);

  // Security Context Check
  if (!window.isSecureContext) {
    logEvent('Web Bluetooth requires HTTPS or http://localhost.', 'WARN');
  }
  if (!('bluetooth' in navigator)) {
    logEvent('Web Bluetooth is not supported in this browser. Use Chrome or Edge.', 'INFO');
  }
});
