(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = id => document.getElementById(id);
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  const readStored = (key,fallback) => {
    try { return localStorage.getItem(key) ?? fallback; }
    catch (_) { return fallback; }
  };
  const writeStored = (key,value) => {
    try { localStorage.setItem(key,value); }
    catch (_) { /* Storage can be blocked in private browsing; the live session continues. */ }
  };
  const makeSvg = name => document.createElementNS(SVG_NS,name);
  const textNode = (x,y,text,className,anchor) => {
    const node = makeSvg('text');
    node.setAttribute('x',x); node.setAttribute('y',y);
    if (className) node.setAttribute('class',className);
    if (anchor) node.setAttribute('text-anchor',anchor);
    node.textContent = text;
    return node;
  };
  const formatClock = milliseconds => {
    const seconds = Math.floor(Math.max(0,milliseconds) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remain = seconds % 60;
    return hours
      ? String(hours).padStart(2,'0') + ':' + String(minutes).padStart(2,'0') + ':' + String(remain).padStart(2,'0')
      : String(Math.floor(seconds / 60)).padStart(2,'0') + ':' + String(remain).padStart(2,'0');
  };
  const formatLap = milliseconds => {
    const elapsed = Math.max(0,milliseconds);
    const totalSeconds = Math.floor(elapsed / 1000);
    return String(Math.floor(totalSeconds / 60)).padStart(2,'0') + ':' +
      String(totalSeconds % 60).padStart(2,'0') + '.' + String(Math.floor(elapsed % 1000 / 10)).padStart(2,'0');
  };
  const formatStamp = timestamp => {
    try { return new Date(timestamp).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
    catch (_) { return new Date(timestamp).toISOString().slice(11,19); }
  };

  // The SVG keeps the original angled two-segment scale. Thickness depends only on position.
  const gaugePoints = [{x:160,y:400},{x:440,y:300},{x:1040,y:300}];
  const gaugeSamples = [];
  let gaugeLength = 0;
  let speed = 0;
  let maximumSpeed = 0;
  let distanceKm = 0;
  let movingDistanceKm = 0;
  let movingTimeMs = 0;
  const movingThreshold = 0.8;
  const movementToleranceMs = 2000;
  let lastPosition = null;
  let insideCheckpoints = new Set();
  let watchId = null;
  let gpsActive = false;
  let simulation = false;
  let activeSource = null;
  let limit = clamp(Number(readStored('gpsDriveLimit','120')) || 120,1,300);
  let autoStartEnabled = readStored('gpsDriveAutoStart','true') !== 'false';
  let autoStartThreshold = clamp(Number(readStored('gpsDriveAutoStartThreshold','5')) || 5,1,30);
  let autoCheckpointsEnabled = readStored('gpsDriveAutoCheckpoints','true') !== 'false';
  let checkpointRadius = clamp(Number(readStored('gpsDriveCheckpointRadius','20')) || 20,5,100);
  let checkpoints = [];
  let sessionHistory = [];
  let lapEntries = [];
  let lapNumber = 0;
  let lapRunning = false;
  let lapStartedBy = '';
  let lapStartTime = 0;
  let lapTimer = null;
  let sessionActive = false;
  let sessionSource = '';
  let sessionStartedAt = 0;
  let tripElapsedMs = 0;
  let tripTimer = null;
  let simulationTimer = null;
  let simulationSampleTime = 0;
  let lastAccuracy = null;
  let pointerSliding = false;

  function thicknessAt(distanceAlong) {
    return 22 + 9 * Math.sin(Math.PI * distanceAlong / gaugeLength * .72);
  }

  function gaugeRibbon(distanceToDraw) {
    const points = gaugeSamples.filter(point => point.distance <= distanceToDraw);
    const next = gaugeSamples.find(point => point.distance > distanceToDraw);
    if (next) points.push(next);
    if (points.length < 2) return '';
    const left = [], right = [];
    points.forEach((point,index) => {
      const previous = points[Math.max(0,index - 1)];
      const following = points[Math.min(points.length - 1,index + 1)];
      const dx = following.x - previous.x, dy = following.y - previous.y;
      const length = Math.hypot(dx,dy) || 1;
      const nx = -dy / length, ny = dx / length;
      const half = thicknessAt(point.distance) / 2;
      left.push([point.x + nx * half,point.y + ny * half]);
      right.push([point.x - nx * half,point.y - ny * half]);
    });
    return 'M' + left.map(point => point.join(',')).join(' L') +
      ' L' + right.reverse().map(point => point.join(',')).join(' L') + ' Z';
  }

  function drawGaugeMarks() {
    const ticks = $('gaugeTicks'), labels = $('gaugeLabels');
    ticks.replaceChildren(); labels.replaceChildren();
    for (let value = 0; value <= 300; value += 10) {
      const distanceAlong = gaugeLength * value / 300;
      const index = Math.min(gaugeSamples.length - 1,Math.round(distanceAlong / gaugeLength * (gaugeSamples.length - 1)));
      const point = gaugeSamples[index];
      const previous = gaugeSamples[Math.max(0,index - 1)];
      const next = gaugeSamples[Math.min(gaugeSamples.length - 1,index + 1)];
      const dx = next.x - previous.x, dy = next.y - previous.y;
      const length = Math.hypot(dx,dy) || 1;
      const nx = -dy / length, ny = dx / length;
      const major = value % 50 === 0;
      const start = thicknessAt(distanceAlong) / 2 + 3;
      const end = start + (major ? 9 : 4);
      const tick = makeSvg('line');
      tick.setAttribute('x1',point.x + nx * start); tick.setAttribute('y1',point.y + ny * start);
      tick.setAttribute('x2',point.x + nx * end); tick.setAttribute('y2',point.y + ny * end);
      if (major) tick.classList.add('major');
      ticks.append(tick);
      if (value % 100 === 0) {
        const label = textNode(
          value === 0 ? point.x : point.x + nx * (thicknessAt(distanceAlong) / 2 + 23),
          value === 0 ? point.y + 31 : point.y + ny * (thicknessAt(distanceAlong) / 2 + 23),
          String(value),'gauge-label','middle'
        );
        labels.append(label);
      }
    }
  }

  function buildGauge() {
    for (let segment = 0; segment < gaugePoints.length - 1; segment++) {
      const start = gaugePoints[segment], end = gaugePoints[segment + 1];
      const length = Math.hypot(end.x - start.x,end.y - start.y);
      const steps = Math.ceil(length / 2);
      for (let i = 0; i <= steps; i++) {
        if (segment > 0 && i === 0) continue;
        const progress = i / steps;
        const x = start.x + (end.x - start.x) * progress;
        const y = start.y + (end.y - start.y) * progress;
        if (gaugeSamples.length) {
          const previous = gaugeSamples[gaugeSamples.length - 1];
          gaugeLength += Math.hypot(x - previous.x,y - previous.y);
        }
        gaugeSamples.push({x,y,distance:gaugeLength});
      }
    }
    $('gaugeTrack').setAttribute('d',gaugeRibbon(gaugeLength));
    drawGaugeMarks();
  }

  function drawGauge(value) {
    $('gaugeFill').setAttribute('d',gaugeRibbon(gaugeLength * clamp(value / 300,0,1)));
    $('speedNumber').textContent = String(Math.round(value));
  }

  function updateMean() {
    const mean = movingTimeMs > 0 ? movingDistanceKm / (movingTimeMs / 3600000) : 0;
    $('average').textContent = String(Math.round(mean));
  }

  function updateLimitIndicator() {
    const exceeded = speed > limit;
    const warning = $('limitStatus');
    warning.textContent = exceeded ? 'LÍMITE SUPERADO' : 'LÍMITE OK';
    warning.classList.toggle('is-ok',!exceeded);
    warning.classList.toggle('is-exceeded',exceeded);
    const meter = $('limitMeter');
    meter.setAttribute('aria-valuenow',String(Math.round(speed)));
    meter.setAttribute('aria-valuemax','300');
    meter.classList.toggle('is-exceeded',exceeded);
    meter.querySelectorAll('.meter-segment').forEach((segment,index) => {
      segment.classList.toggle('is-lit',speed / 300 * 8 > index);
    });
  }

  function updateSpeedDisplay(value,accuracy = null,source = activeSource) {
    speed = clamp(Number(value) || 0,0,300);
    drawGauge(speed);
    if (accuracy !== null && accuracy !== undefined) lastAccuracy = accuracy;
    $('accuracy').textContent = lastAccuracy == null ? '--' : Math.round(lastAccuracy) + ' m';
    $('gpsAccuracy').textContent = lastAccuracy == null ? '--' : Math.round(lastAccuracy) + ' m';
    if (speed > maximumSpeed) {
      maximumSpeed = speed;
      $('maximum').textContent = maximumSpeed.toFixed(1);
      $('maxInline').textContent = String(Math.round(maximumSpeed));
    }
    updateMean();
    updateLimitIndicator();
    updateSourceIndicator(source);
    if (source && autoStartEnabled && !lapRunning && speed >= autoStartThreshold) {
      startLap(source === 'gps' ? 'AUTO GPS' : 'AUTO SIM',Date.now());
    }
  }

  function updateSourceIndicator(source) {
    const status = $('gpsStatus');
    status.classList.toggle('is-connected',source === 'gps');
    status.classList.toggle('is-simulated',source === 'simulation');
    status.classList.toggle('is-error',source === 'error');
    status.classList.toggle('is-disconnected',!source);
    $('liveLabel').classList.toggle('is-simulated',source === 'simulation');
    $('liveLabel').classList.toggle('is-inactive',!source);
    $('liveLamp').setAttribute('fill',source === 'simulation' ? '#d348ff' : source === 'gps' ? '#00f096' : '#758da3');
    $('gpsStatusText').textContent = source === 'gps' ? 'GPS CONECTADO'
      : source === 'simulation' ? 'MODO SIMULACIÓN'
      : source === 'error' ? 'ERROR GPS'
      : 'GPS DESCONECTADO';
    $('liveLabel').textContent = source === 'gps' ? 'LIVE DATA'
      : source === 'simulation' ? 'DATOS SIMULADOS'
      : 'GPS OFFLINE';
  }

  function bindButton(id,handler) {
    const element = $(id);
    element.addEventListener('click',event => {
      if (element.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      handler(event);
    });
    element.addEventListener('keydown',event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (element.getAttribute('aria-disabled') !== 'true') handler(event);
    });
  }

  function setDisabled(id,disabled) {
    const element = $(id);
    element.classList.toggle('is-disabled',disabled);
    element.setAttribute('aria-disabled',String(disabled));
  }

  function showPage(page) {
    ['drive','laps','gps','settings'].forEach(name => {
      $('view-' + name).style.display = name === page ? 'inline' : 'none';
      const tab = $('tab-' + name);
      const active = name === page;
      tab.classList.toggle('is-active',active);
      const shape = tab.querySelector('path');
      shape.setAttribute('fill',active ? 'url(#activeTab)' : '#030b19');
      shape.setAttribute('stroke',active ? '#0cbcff' : '#1c4e78');
      if (active) shape.setAttribute('filter','url(#blueGlow)');
      else shape.removeAttribute('filter');
      tab.setAttribute('aria-current',active ? 'page' : 'false');
    });
    if (page === 'gps') { renderCheckpoints(); renderHistory(); }
    if (page === 'laps') renderLaps();
  }

  document.querySelectorAll('.nav-tab').forEach(tab => {
    bindButton(tab.id,() => showPage(tab.dataset.page));
  });

  function updateTripClock() {
    if (!sessionActive) return;
    $('duration').textContent = formatClock(tripElapsedMs + Date.now() - sessionStartedAt);
  }

  function resetTripStats() {
    speed = 0; maximumSpeed = 0; distanceKm = 0; movingDistanceKm = 0; movingTimeMs = 0;
    lastPosition = null; lastAccuracy = null;
    $('distance').textContent = '0.00'; $('maximum').textContent = '0.0'; $('maxInline').textContent = '0';
    $('duration').textContent = '00:00'; $('accuracy').textContent = '--'; $('gpsAccuracy').textContent = '--';
    $('latitude').textContent = '--'; $('longitude').textContent = '--'; $('altitude').textContent = '--';
    updateMean(); drawGauge(0); updateLimitIndicator();
  }

  function beginSession(source) {
    if (sessionActive) return;
    resetTripStats();
    sessionActive = true;
    sessionSource = source;
    sessionStartedAt = Date.now();
    tripElapsedMs = 0;
    clearInterval(tripTimer);
    tripTimer = setInterval(updateTripClock,500);
  }

  function currentTripElapsed() {
    return tripElapsedMs + (sessionActive ? Date.now() - sessionStartedAt : 0);
  }

  function finishSession() {
    if (!sessionActive) return;
    tripElapsedMs = currentTripElapsed();
    updateTripClock();
    clearInterval(tripTimer); tripTimer = null; sessionActive = false;
    const mean = movingTimeMs ? movingDistanceKm / (movingTimeMs / 3600000) : 0;
    const entry = {
      id:'session-' + Date.now(),source:sessionSource,endedAt:Date.now(),durationMs:tripElapsedMs,
      distanceKm:distanceKm,maxSpeed:maximumSpeed,averageSpeed:mean
    };
    if (entry.durationMs > 1000 || entry.distanceKm > 0) {
      sessionHistory.push(entry);
      sessionHistory = sessionHistory.slice(-20);
      writeStored('gpsDriveSessions',JSON.stringify(sessionHistory));
      renderHistory();
    }
    sessionSource = '';
  }

  function radians(value) { return value * Math.PI / 180; }
  function calculateDistance(a,b) {
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h),Math.sqrt(1 - h));
  }

  function updateCoordinates(coords) {
    $('latitude').textContent = coords.latitude.toFixed(6);
    $('longitude').textContent = coords.longitude.toFixed(6);
    $('altitude').textContent = coords.altitude == null ? '--' : Math.round(coords.altitude) + ' m';
  }

  function processPosition(position) {
    if (!gpsActive) return;
    const coords = position.coords;
    const timestamp = Number(position.timestamp) || Date.now();
    const current = {latitude:coords.latitude,longitude:coords.longitude,timestamp,speed:0};
    let segmentKm = 0, elapsed = 0, segmentSpeed = 0;
    if (lastPosition) {
      elapsed = timestamp - lastPosition.timestamp;
      segmentKm = calculateDistance(lastPosition,current);
      if (segmentKm < 1) {
        distanceKm += segmentKm;
        if (elapsed > 0) segmentSpeed = segmentKm / (elapsed / 3600000);
      } else segmentKm = 0;
    }
    const gpsSpeed = coords.speed == null
      ? segmentSpeed
      : Math.max(0,coords.speed * 3.6);
    current.speed = gpsSpeed;
    if (lastPosition && elapsed > 0 && elapsed <= movementToleranceMs && segmentKm >= .0005 &&
        segmentSpeed >= movingThreshold) {
      movingDistanceKm += segmentKm;
      movingTimeMs += elapsed;
    }
    lastPosition = current;
    updateCoordinates(coords);
    updateSpeedDisplay(gpsSpeed,coords.accuracy,'gps');
    $('distance').textContent = distanceKm.toFixed(2);
    updateMean();
    evaluateCheckpoints(current,timestamp);
    if (autoStartEnabled && !lapRunning && gpsSpeed >= autoStartThreshold) startLap('AUTO GPS',timestamp);
  }

  function setGpsStatus(message,state) {
    updateSourceIndicator(state === 'connected' ? 'gps' : state === 'simulated' ? 'simulation' : state === 'error' ? 'error' : null);
    $('gpsStatusText').textContent = message;
  }

  function gpsError(error) {
    const messages = {1:'PERMISO GPS DENEGADO',2:'GPS NO DISPONIBLE',3:'SEÑAL GPS EN ESPERA'};
    setGpsStatus(messages[error.code] || 'ERROR GPS','error');
    if (error.code === 1 || error.code === 2) {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null; gpsActive = false;
      clearInterval(tripTimer); tripTimer = null;
      setDisabled('startGPS',false); setDisabled('stopGPS',true);
      activeSource = null;
      finishSession();
    }
  }

  function startGPS() {
    if (gpsActive) return;
    if (simulation) toggleSimulation(false);
    if (!navigator.geolocation) {
      setGpsStatus('GPS NO DISPONIBLE','error');
      return;
    }
    gpsActive = true; activeSource = 'gps'; lastPosition = null; insideCheckpoints.clear();
    beginSession('GPS REAL');
    setGpsStatus('BUSCANDO GPS','connected');
    setDisabled('startGPS',true); setDisabled('stopGPS',false);
    try {
      watchId = navigator.geolocation.watchPosition(processPosition,gpsError,{
        enableHighAccuracy:true,maximumAge:1000,timeout:15000
      });
    } catch (_) {
      gpsActive = false; activeSource = null;
      setDisabled('startGPS',false); setDisabled('stopGPS',true);
      setGpsStatus('GPS NO DISPONIBLE','error'); finishSession();
    }
  }

  function stopGPS() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null; gpsActive = false;
    clearInterval(tripTimer); tripTimer = null;
    if (lapRunning && lapStartedBy.indexOf('AUTO') === 0) stopLap();
    setDisabled('startGPS',false); setDisabled('stopGPS',true);
    activeSource = null; updateSourceIndicator(null);
    updateSpeedDisplay(0,null,null);
    finishSession();
  }
  bindButton('startGPS',startGPS);
  bindButton('stopGPS',stopGPS);

  function updateSimulationSlider(value) {
    const val = clamp(Math.round(Number(value) || 0),0,300);
    $('testSpeed').setAttribute('aria-valuenow',String(val));
    $('testSpeedThumb').setAttribute('cx',String(863 + (1408 - 863) * val / 300));
    $('testSpeedValue').textContent = val + ' KM/H';
    if (simulation) updateSpeedDisplay(val,null,'simulation');
  }

  function sampleSimulationDistance() {
    const now = Date.now();
    const elapsed = Math.min(Math.max(0,now - simulationSampleTime),movementToleranceMs);
    simulationSampleTime = now;
    if (speed >= movingThreshold && elapsed > 0) {
      const segment = speed * elapsed / 3600000;
      distanceKm += segment; movingDistanceKm += segment; movingTimeMs += elapsed;
      $('distance').textContent = distanceKm.toFixed(2);
      updateMean();
    }
  }

  function toggleSimulation(force) {
    const enable = typeof force === 'boolean' ? force : !simulation;
    if (enable === simulation) return;
    if (enable) {
      if (gpsActive) stopGPS();
      simulation = true; activeSource = 'simulation';
      beginSession('SIMULACIÓN');
      $('testToggle').setAttribute('aria-pressed','true');
      $('testToggle').setAttribute('aria-label','Desactivar simulación');
      $('testToggleLabel').textContent = 'DESACTIVAR SIMULACIÓN';
      $('testStatus').textContent = 'SIMULACIÓN ACTIVADA';
      $('testStatus').classList.add('is-enabled');
      setGpsStatus('MODO SIMULACIÓN','simulated');
      updateSimulationSlider(Number($('testSpeed').getAttribute('aria-valuenow')));
      simulationSampleTime = Date.now();
      clearInterval(simulationTimer);
      simulationTimer = setInterval(sampleSimulationDistance,500);
      return;
    }
    sampleSimulationDistance();
    clearInterval(simulationTimer); simulationTimer = null;
    if (lapRunning && lapStartedBy.indexOf('AUTO') === 0) stopLap();
    simulation = false; activeSource = null;
    $('testToggle').setAttribute('aria-pressed','false');
    $('testToggle').setAttribute('aria-label','Activar simulación');
    $('testToggleLabel').textContent = 'ACTIVAR SIMULACIÓN';
    $('testStatus').textContent = 'SIMULACIÓN DESACTIVADA';
    $('testStatus').classList.remove('is-enabled');
    updateSpeedDisplay(0,null,null);
    updateSourceIndicator(null); finishSession();
  }
  bindButton('testToggle',() => toggleSimulation());

  function svgXFromEvent(event) {
    const svg = document.querySelector('.artboard');
    if (!svg || !svg.createSVGPoint || !svg.getScreenCTM()) return 857;
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse()).x;
  }
  function setSliderFromEvent(event) {
    const x = svgXFromEvent(event);
    updateSimulationSlider((x - 863) / (1408 - 863) * 300);
  }
  $('testSpeed').addEventListener('pointerdown',event => {
    pointerSliding = true;
    if ($('testSpeed').setPointerCapture) $('testSpeed').setPointerCapture(event.pointerId);
    setSliderFromEvent(event); event.preventDefault();
  });
  $('testSpeed').addEventListener('pointermove',event => {
    if (pointerSliding) setSliderFromEvent(event);
  });
  $('testSpeed').addEventListener('pointerup',() => { pointerSliding = false; });
  $('testSpeed').addEventListener('pointercancel',() => { pointerSliding = false; });
  $('testSpeed').addEventListener('keydown',event => {
    const current = Number($('testSpeed').getAttribute('aria-valuenow')) || 0;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') updateSimulationSlider(current + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') updateSimulationSlider(current - 1);
    else if (event.key === 'Home') updateSimulationSlider(0);
    else if (event.key === 'End') updateSimulationSlider(300);
    else return;
    event.preventDefault();
  });

  function renderLaps() {
    const list = $('lapList'); list.replaceChildren();
    if (!lapEntries.length) {
      list.append(textNode(120,625,'NO HAY VUELTAS REGISTRADAS','page-small'));
      return;
    }
    lapEntries.slice(0,4).forEach((lap,index) => {
      const y = 625 + index * 31;
      list.append(textNode(120,y,'VUELTA ' + String(lap.number).padStart(2,'0'),'data-row-label'));
      list.append(textNode(755,y,formatLap(lap.durationMs),'data-row-label','end'));
      list.append(textNode(1470,y,lap.source,'data-row-small','end'));
      if (index < 3) {
        const line = makeSvg('path'); line.setAttribute('d','M100 ' + (y + 9) + 'H1500'); line.setAttribute('class','page-separator'); list.append(line);
      }
    });
  }

  function updateLapClock() {
    if (lapRunning) $('lapClock').textContent = formatLap(Date.now() - lapStartTime);
  }
  function updateLapStatus() {
    const finish = checkpoints.find(point => point.finishLine);
    $('lapAutoStatus').textContent = (autoStartEnabled ? 'AUTO START ≥ ' + autoStartThreshold + ' KM/H' : 'AUTO START OFF') +
      ' · ' + (finish ? 'META CP ' + String(checkpoints.indexOf(finish) + 1).padStart(2,'0') : 'FINISH CHECKPOINT NOT SET');
  }
  function startLap(source = 'MANUAL',timestamp = Date.now()) {
    if (lapRunning) return;
    lapRunning = true; lapStartedBy = source; lapStartTime = timestamp;
    clearInterval(lapTimer); lapTimer = setInterval(updateLapClock,30);
    $('lapClock').textContent = '00:00.00';
    setDisabled('lapStart',true); setDisabled('lapStop',false);
    updateLapStatus();
  }
  function markLap(timestamp = Date.now(),source = 'MANUAL') {
    if (!lapRunning) return;
    const elapsed = Math.max(0,timestamp - lapStartTime);
    lapNumber++;
    lapEntries.unshift({number:lapNumber,durationMs:elapsed,source,endedAt:timestamp});
    lapEntries = lapEntries.slice(0,20);
    writeStored('gpsDriveLaps',JSON.stringify(lapEntries));
    renderLaps();
    lapStartTime = timestamp;
    $('lapClock').textContent = '00:00.00';
    lapStartedBy = source;
  }
  function stopLap() {
    if (!lapRunning) return;
    updateLapClock(); lapRunning = false;
    clearInterval(lapTimer); lapTimer = null;
    setDisabled('lapStart',false); setDisabled('lapStop',true);
  }
  function resetLap() {
    stopLap(); lapNumber = 0; lapEntries = [];
    $('lapClock').textContent = '00:00.00';
    writeStored('gpsDriveLaps','[]'); renderLaps(); updateLapStatus();
  }
  bindButton('lapStart',() => startLap('MANUAL'));
  bindButton('lapMark',() => markLap(Date.now(),'MANUAL'));
  bindButton('lapStop',stopLap);
  bindButton('lapReset',resetLap);

  function persistCheckpoints() {
    writeStored('gpsDriveCheckpoints',JSON.stringify(checkpoints));
    renderCheckpoints(); updateLapStatus(); updateSettingsView();
  }
  function addCheckpoint(position = lastPosition) {
    if (!position || activeSource !== 'gps') {
      $('checkpointFeedback').textContent = 'SE NECESITA UNA POSICIÓN GPS REAL';
      return;
    }
    checkpoints.push({
      id:'cp-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
      latitude:position.latitude,longitude:position.longitude,finishLine:checkpoints.length === 0,
      createdAt:Date.now(),hits:[]
    });
    $('checkpointFeedback').textContent = 'CHECKPOINT GUARDADO';
    persistCheckpoints();
  }
  function renderCheckpoints() {
    const list = $('checkpointList');
    if (!list) return;
    list.replaceChildren();
    if (!checkpoints.length) {
      list.append(textNode(110,594,'NO HAY CHECKPOINTS · GUARDA UNO CON GPS ACTIVO','page-small'));
      return;
    }
    const visible = checkpoints.slice(-5);
    const offset = checkpoints.length - visible.length;
    visible.forEach((point,index) => {
      const originalIndex = offset + index;
      const y = 590 + index * 31;
      const row = makeSvg('g'); row.classList.add('dynamic-row'); row.setAttribute('id','checkpoint-row-' + point.id);
      row.append(textNode(110,y,'CP' + String(originalIndex + 1).padStart(2,'0') + '  ' + point.latitude.toFixed(5) + ', ' + point.longitude.toFixed(5),'data-row-label'));
      const lastHit = point.hits[point.hits.length - 1];
      row.append(textNode(590,y,point.hits.length + ' PASOS' + (lastHit ? ' · ' + formatStamp(lastHit.timestamp) : ''),'data-row-small'));
      const finish = textNode(690,y,point.finishLine ? 'META GPS' : 'MARCAR META','data-action-label');
      finish.classList.add('interactive');
      const remove = textNode(816,y,'×','data-action-label','end'); remove.classList.add('interactive');
      row.append(finish,remove);
      finish.addEventListener('click',event => { event.stopPropagation(); toggleFinishLine(point.id); });
      remove.addEventListener('click',event => { event.stopPropagation(); deleteCheckpoint(point.id); });
      finish.addEventListener('keydown',event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleFinishLine(point.id); } });
      list.append(row);
      if (index < visible.length - 1) {
        const line = makeSvg('path'); line.setAttribute('d','M100 ' + (y + 9) + 'H830'); line.setAttribute('class','page-separator'); list.append(line);
      }
    });
    if (offset > 0) list.append(textNode(110,748,'+' + offset + ' CHECKPOINTS ANTERIORES','page-small'));
  }
  function toggleFinishLine(id) {
    checkpoints = checkpoints.map(point => ({...point,finishLine:point.id === id ? !point.finishLine : false}));
    persistCheckpoints();
  }
  function deleteCheckpoint(id) {
    checkpoints = checkpoints.filter(point => point.id !== id);
    insideCheckpoints.delete(id); persistCheckpoints();
  }
  function evaluateCheckpoints(position,timestamp) {
    if (!autoCheckpointsEnabled) return;
    checkpoints.forEach((point,index) => {
      const fromPoint = calculateDistance(point,{latitude:position.latitude,longitude:position.longitude}) * 1000;
      if (insideCheckpoints.has(point.id) && fromPoint > checkpointRadius + 10) insideCheckpoints.delete(point.id);
      if (fromPoint > checkpointRadius || insideCheckpoints.has(point.id)) return;
      insideCheckpoints.add(point.id);
      const hit = {timestamp,latitude:position.latitude,longitude:position.longitude,distanceM:Math.round(fromPoint)};
      point.hits.push(hit); point.hits = point.hits.slice(-20);
      $('checkpointFeedback').textContent = 'PASO CP' + String(index + 1).padStart(2,'0') + ' · ' + formatStamp(timestamp);
      if (point.finishLine && lapRunning) markLap(timestamp,'GPS META');
      writeStored('gpsDriveCheckpoints',JSON.stringify(checkpoints));
      renderCheckpoints();
    });
  }
  bindButton('saveCheckpoint',() => addCheckpoint());

  function renderHistory() {
    const list = $('sessionHistory');
    if (!list) return;
    list.replaceChildren();
    if (!sessionHistory.length) {
      list.append(textNode(920,405,'NO HAY SESIONES GUARDADAS','page-small'));
      return;
    }
    sessionHistory.slice(-6).reverse().forEach((entry,index) => {
      const y = 400 + index * 52;
      const date = formatStamp(entry.endedAt);
      list.append(textNode(920,y,(entry.source === 'SIMULACIÓN' ? 'SIM · ' : 'GPS · ') + date,'data-row-label'));
      list.append(textNode(920,y + 23,entry.distanceKm.toFixed(2) + ' KM  ·  MEDIA ' + Math.round(entry.averageSpeed) + '  ·  MÁX ' + entry.maxSpeed.toFixed(1),'data-row-small'));
      list.append(textNode(1480,y,formatClock(entry.durationMs),'data-row-label','end'));
      if (index < 5) { const line = makeSvg('path'); line.setAttribute('d','M920 ' + (y + 32) + 'H1480'); line.setAttribute('class','page-separator'); list.append(line); }
    });
  }

  function updateSettingsView() {
    $('limitValue').textContent = String(limit);
    $('limitReadout').textContent = String(limit);
    $('autoStartValue').textContent = autoStartEnabled ? 'ACTIVADO' : 'DESACTIVADO';
    $('autoStartThreshold').textContent = autoStartThreshold + ' KM/H';
    $('autoCheckpointValue').textContent = autoCheckpointsEnabled ? 'ACTIVADOS' : 'DESACTIVADOS';
    $('checkpointRadius').textContent = checkpointRadius + ' M';
    const finish = checkpoints.find(point => point.finishLine);
    $('finishCheckpointValue').textContent = finish ? 'CP' + String(checkpoints.indexOf(finish) + 1).padStart(2,'0') : 'NO CONFIGURADA';
    const autoTrack = $('autoStartToggle').querySelector('.toggle-track');
    const autoKnob = $('autoStartToggle').querySelector('.toggle-knob');
    autoTrack.classList.toggle('is-on',autoStartEnabled); autoTrack.setAttribute('fill',autoStartEnabled ? '#078aff' : '#13263a');
    autoKnob.setAttribute('cx',autoStartEnabled ? '686' : '630');
    $('autoStartToggle').setAttribute('aria-pressed',String(autoStartEnabled));
    const cpTrack = $('autoCheckpointToggle').querySelector('.toggle-track');
    const cpKnob = $('autoCheckpointToggle').querySelector('.toggle-knob');
    cpTrack.classList.toggle('is-on',autoCheckpointsEnabled); cpTrack.setAttribute('fill',autoCheckpointsEnabled ? '#078aff' : '#13263a');
    cpKnob.setAttribute('cx',autoCheckpointsEnabled ? '1399' : '1343');
    $('autoCheckpointToggle').setAttribute('aria-pressed',String(autoCheckpointsEnabled));
  }
  function saveSettings() {
    writeStored('gpsDriveLimit',String(limit));
    writeStored('gpsDriveAutoStart',String(autoStartEnabled));
    writeStored('gpsDriveAutoStartThreshold',String(autoStartThreshold));
    writeStored('gpsDriveAutoCheckpoints',String(autoCheckpointsEnabled));
    writeStored('gpsDriveCheckpointRadius',String(checkpointRadius));
    updateSettingsView(); updateLimitIndicator();
  }
  bindButton('limitMinus',() => { limit = clamp(limit - 5,1,300); saveSettings(); });
  bindButton('limitPlus',() => { limit = clamp(limit + 5,1,300); saveSettings(); });
  bindButton('autoStartToggle',() => { autoStartEnabled = !autoStartEnabled; saveSettings(); updateLapStatus(); });
  bindButton('thresholdMinus',() => { autoStartThreshold = clamp(autoStartThreshold - 1,1,30); saveSettings(); updateLapStatus(); });
  bindButton('thresholdPlus',() => { autoStartThreshold = clamp(autoStartThreshold + 1,1,30); saveSettings(); updateLapStatus(); });
  bindButton('autoCheckpointToggle',() => { autoCheckpointsEnabled = !autoCheckpointsEnabled; saveSettings(); });
  bindButton('radiusMinus',() => { checkpointRadius = clamp(checkpointRadius - 5,5,100); saveSettings(); });
  bindButton('radiusPlus',() => { checkpointRadius = clamp(checkpointRadius + 5,5,100); saveSettings(); });

  function normalizeCheckpoints(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(point => Number.isFinite(Number(point.lat ?? point.latitude)) && Number.isFinite(Number(point.lon ?? point.longitude)))
      .map((point,index) => ({
        id:point.id || 'cp-restored-' + index + '-' + Math.random().toString(36).slice(2,6),
        latitude:Number(point.latitude ?? point.lat),longitude:Number(point.longitude ?? point.lon),
        finishLine:Boolean(point.finishLine),createdAt:Number(point.createdAt) || Date.now(),
        hits:Array.isArray(point.hits) ? point.hits : []
      }));
  }
  try { checkpoints = normalizeCheckpoints(JSON.parse(readStored('gpsDriveCheckpoints','[]'))); }
  catch (_) { checkpoints = []; }
  try {
    const storedHistory = JSON.parse(readStored('gpsDriveSessions','[]'));
    sessionHistory = Array.isArray(storedHistory) ? storedHistory : [];
  } catch (_) { sessionHistory = []; }
  try {
    const storedLaps = JSON.parse(readStored('gpsDriveLaps','[]'));
    lapEntries = Array.isArray(storedLaps) ? storedLaps : [];
    lapNumber = lapEntries.reduce((maximum,lap) => Math.max(maximum,Number(lap.number) || 0),0);
  } catch (_) { lapEntries = []; }

  buildGauge();
  updateSettingsView();
  renderLaps(); renderCheckpoints(); renderHistory();
  updateSourceIndicator(null);
  updateSpeedDisplay(0,null,null);
  updateLapStatus();
  setDisabled('stopGPS',true); setDisabled('lapStop',true);
  showPage('drive');
  if ('serviceWorker' in navigator && typeof location !== 'undefined' && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
