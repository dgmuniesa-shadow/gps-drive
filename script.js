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
  const formatTrackClock = milliseconds => {
    const totalSeconds = Math.floor(Math.max(0,milliseconds) / 1000);
    return String(Math.floor(totalSeconds / 3600)).padStart(2,'0') + ':' +
      String(Math.floor(totalSeconds % 3600 / 60)).padStart(2,'0') + ':' +
      String(totalSeconds % 60).padStart(2,'0');
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
  let watchId = null;
  let gpsActive = false;
  let gpsFixAvailable = false;
  let activeSource = null;
  const storedLimitRaw = readStored('gpsDriveLimit',null);
  const storedLimit = Number(storedLimitRaw);
  const savedLimitEnabled = readStored('gpsDriveLimitEnabled',null);
  const migratedCustomLimit = savedLimitEnabled === null && storedLimitRaw !== null &&
    Number.isFinite(storedLimit) && storedLimit > 0 && storedLimit !== 120;
  let limit = Number.isFinite(storedLimit) && storedLimit >= 1 ? clamp(storedLimit,1,300) : 120;
  let limitEnabled = savedLimitEnabled === 'true' || migratedCustomLimit;
  let checkpointRadius = clamp(Number(readStored('gpsDriveCheckpointRadius','20')) || 20,5,100);
  let draftMarks = [];
  let tracks = [];
  let tracksStorageWritable = true;
  let activeTrackId = readStored('gpsDriveSelectedTrack','');
  let nextTrackNumber = Math.max(1,Number(readStored('gpsDriveNextTrackNumber','1')) || 1);
  let activeTrackRun = null;
  let activeTrackReverse = readStored('gpsDriveTrackReversed','false') === 'true';
  let driveRecording = false;
  let manualLapElapsedMs = 0;
  let manualLapLastMarkMs = 0;
  let manualLapRecords = [];
  let showLegacyLapRecords = readStored('gpsDriveManualLaps',null) === null;
  let countdownTimer = null;
  let trackClockTimer = null;
  let countdownRunning = false;
  let trackStartNearby = false;
  let trackFinishNearby = false;
  let pendingTrackConfirmation = null;
  let selectedLapPickerId = '';
  let resultsFilterId = 'best';
  let dropdownStates = {
    lap:{offset:0,maxOffset:0,drag:null},
    results:{offset:0,maxOffset:0,drag:null}
  };
  let sessionHistory = [];
  let sessionsStorageWritable = true;
  let lapEntries = [];
  let lapRunning = false;
  let lapStartTime = 0;
  let lapTimer = null;
  let sessionActive = false;
  let sessionSource = '';
  let sessionStartedAt = 0;
  let tripElapsedMs = 0;
  let tripTimer = null;
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
    const configured = limitEnabled;
    const reading = $('mainLimitReading');
    const exceeded = configured && speed > limit;
    reading.textContent = configured ? 'LIM. ' + limit : '-';
    reading.classList.toggle('is-exceeded',exceeded);
    reading.classList.toggle('is-inactive',!configured);
  }

  function updateSpeedDisplay(value,accuracy = null,source = activeSource) {
    speed = clamp(Number(value) || 0,0,300);
    drawGauge(speed);
    if (accuracy !== null && accuracy !== undefined) lastAccuracy = accuracy;
    $('accuracy').textContent = lastAccuracy == null ? '--' : Math.round(lastAccuracy) + ' m';
    if (driveRecording && speed > maximumSpeed) {
      maximumSpeed = speed;
      $('maximum').textContent = maximumSpeed.toFixed(1);
      $('maxInline').textContent = String(Math.round(maximumSpeed));
    }
    updateMean();
    updateLimitIndicator();
    updateSourceIndicator(source);
  }

  function updateSourceIndicator(source) {
    const status = $('gpsStatus');
    status.classList.toggle('is-connected',source === 'gps');
    status.classList.toggle('is-error',source === 'error');
    status.classList.toggle('is-disconnected',!source);
    status.setAttribute('aria-label',source === 'gps' ? 'GPS conectado' : 'Conectar GPS');
    $('liveLabel').classList.toggle('is-inactive',!source);
    $('liveLamp').setAttribute('fill',source === 'gps' ? '#00f096' : '#758da3');
    $('gpsStatusText').textContent = source === 'gps' ? 'GPS CONECTADO'
      : source === 'error' ? 'ERROR GPS'
      : 'GPS DESCONECTADO';
    $('liveLabel').textContent = source === 'gps' ? 'LIVE DATA'
      : 'GPS OFFLINE';
  }

  function bindButton(id,handler) {
    const element = $(id);
    let lastActivation = 0;
    const activate = event => {
      if (element.getAttribute('aria-disabled') === 'true') return;
      lastActivation = Date.now();
      handler(event);
    };
    element.addEventListener('pointerup',event => {
      if (event.isPrimary === false || (event.button != null && event.button !== 0)) return;
      activate(event);
    });
    element.addEventListener('click',event => {
      event.preventDefault();
      if (Date.now() - lastActivation < 700) return;
      activate(event);
    });
    element.addEventListener('keydown',event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (Date.now() - lastActivation >= 700) activate(event);
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
    if (page === 'gps') { renderTrackDraft(); renderTrackList(); renderTrackResults(); renderTrackPickers(); }
    if (page === 'laps') renderLapPanel();
  }

  document.querySelectorAll('.nav-tab').forEach(tab => {
    bindButton(tab.id,() => showPage(tab.dataset.page));
  });
  bindButton('gpsStatus',startGPS);

  function updateTripClock() {
    if (!sessionActive || !driveRecording) return;
    $('duration').textContent = formatClock(tripElapsedMs + Date.now() - sessionStartedAt);
  }

  function resetTripStats() {
    maximumSpeed = 0; distanceKm = 0; movingDistanceKm = 0; movingTimeMs = 0;
    $('distance').textContent = '0.00'; $('maximum').textContent = '0.0'; $('maxInline').textContent = '0';
    $('duration').textContent = '00:00'; $('accuracy').textContent = lastAccuracy == null ? '--' : Math.round(lastAccuracy)+' m';
    updateMean(); drawGauge(speed); updateLimitIndicator();
  }

  function beginSession(source) {
    if (sessionActive) return;
    sessionActive = true;
    driveRecording = true;
    sessionSource = source;
    sessionStartedAt = Date.now();
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
      if (sessionsStorageWritable) writeStored('gpsDriveSessions',JSON.stringify(sessionHistory));
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
    const accuracy = coords.accuracy == null ? '--' : Math.round(coords.accuracy) + ' M';
    $('trackDraftFeedback').textContent = 'GPS REAL · PRECISIÓN ' + accuracy;
  }

  function processPosition(position) {
    if (!gpsActive) return;
    gpsFixAvailable=true;
    const coords = position.coords;
    const timestamp = Number(position.timestamp) || Date.now();
    const current = {
      latitude:coords.latitude,longitude:coords.longitude,timestamp,speed:0,
      altitude:coords.altitude == null ? null : coords.altitude,
      accuracy:coords.accuracy == null ? null : coords.accuracy
    };
    const previousPosition = lastPosition;
    let segmentKm = 0, elapsed = 0, segmentSpeed = 0;
    if (lastPosition) {
      elapsed = timestamp - lastPosition.timestamp;
      segmentKm = calculateDistance(lastPosition,current);
      if (segmentKm < 1) {
        if (driveRecording) distanceKm += segmentKm;
        if (elapsed > 0) segmentSpeed = segmentKm / (elapsed / 3600000);
      } else segmentKm = 0;
    }
    const gpsSpeed = coords.speed == null
      ? segmentSpeed
      : Math.max(0,coords.speed * 3.6);
    current.speed = gpsSpeed;
    if (activeTrackRun && segmentKm > 0) activeTrackRun.distanceKm += segmentKm;
    if (driveRecording && lastPosition && elapsed > 0 && elapsed <= movementToleranceMs && segmentKm >= .0005 &&
        segmentSpeed >= movingThreshold) {
      movingDistanceKm += segmentKm;
      movingTimeMs += elapsed;
    }
    lastPosition = current;
    updateCoordinates(coords);
    updateSpeedDisplay(gpsSpeed,coords.accuracy,'gps');
    $('distance').textContent = distanceKm.toFixed(2);
    updateMean();
    evaluateActiveTrack(current,timestamp,previousPosition);
    updateLapView();
  }

  function setGpsStatus(message,state) {
    updateSourceIndicator(state === 'connected' ? 'gps' : state === 'error' ? 'error' : null);
    $('gpsStatusText').textContent = message;
  }

  function gpsError(error) {
    gpsFixAvailable=false;
    const messages = {1:'PERMISO GPS DENEGADO',2:'GPS NO DISPONIBLE',3:'SEÑAL GPS EN ESPERA'};
    setGpsStatus(messages[error.code] || 'ERROR GPS','error');
    if (error.code === 1 || error.code === 2) {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null; gpsActive = false;
      clearInterval(tripTimer); tripTimer = null;
      countdownRunning = false;
      if (countdownTimer) clearTimeout(countdownTimer);
      setDisabled('startGPS',false); setDisabled('stopGPS',true);
      activeSource = null;
      finishSession();
      driveRecording=false;
    }
    renderTrackTimeStatus(); updateLapView();
  }

  function startGPS() {
    if (gpsActive) return;
    if (!navigator.geolocation) {
      setGpsStatus('GPS NO DISPONIBLE','error');
      return;
    }
    gpsActive = true; gpsFixAvailable=false; activeSource = 'gps'; lastPosition = null;
    driveRecording = true;
    beginSession('GPS REAL');
    setGpsStatus('BUSCANDO GPS','disconnected');
    setDisabled('startGPS',false); setDisabled('stopGPS',false);
    try {
      watchId = navigator.geolocation.watchPosition(processPosition,gpsError,{
        enableHighAccuracy:true,maximumAge:1000,timeout:15000
      });
    } catch (_) {
      gpsActive = false; gpsFixAvailable=false; activeSource = null;
      setDisabled('startGPS',false); setDisabled('stopGPS',true);
      setGpsStatus('GPS NO DISPONIBLE','error'); finishSession();
    }
  }

  function stopGPS() {
    if (sessionActive) {
      tripElapsedMs = currentTripElapsed();
      finishSession();
    }
    driveRecording = false;
    $('gpsStatusText').textContent = gpsActive ? 'GPS CONECTADO' : 'GPS DESCONECTADO';
    setDisabled('stopGPS',true);
    $('duration').textContent = formatClock(tripElapsedMs);
  }
  function resetDrive() {
    resetTripStats();
    tripElapsedMs=0;
    if (gpsActive) {
      driveRecording=true; sessionActive=true; sessionStartedAt=Date.now();
      sessionSource='GPS REAL'; clearInterval(tripTimer); tripTimer=setInterval(updateTripClock,500);
      setDisabled('stopGPS',false);
    } else {
      driveRecording=false; sessionActive=false;
      clearInterval(tripTimer); tripTimer=null;
      setDisabled('stopGPS',true);
    }
  }
  bindButton('startGPS',resetDrive);
  bindButton('stopGPS',stopGPS);

  function startTrackRun(timestamp = Date.now(),skipStart = false,position = lastPosition) {
    const track = getActiveTrack();
    const route = getActiveRoute();
    if (!track || route.length < 2 || activeTrackRun) return false;
    activeTrackRun = {
      trackId:track.id,reverse:activeTrackReverse,startedAt:timestamp,startDistanceKm:distanceKm,
      distanceKm:0,progressKm:0,maxSpeed:speed,samples:[],checkpointSplits:[{markIndex:activeTrackReverse?track.marks.length-1:0,
        type:'START',timestamp,elapsedMs:0,segmentTimeMs:0,segmentDistanceKm:0,averageSpeedKmh:0,
        speedKmh:position?.speed == null ? speed : Number(position.speed)}],nextCheckpoint:1,lastCheckpointAt:timestamp,
      lastCheckpointDistanceKm:0,finishArmed:skipStart || false
    };
    clearInterval(trackClockTimer); trackClockTimer=setInterval(updateTrackViewClock,30);
    trackStartNearby = true;
    if(position) appendTrackTelemetry(position,timestamp);
    renderTrackTimeStatus();
    return true;
  }

  function beginCountdown() {
    if (!gpsActive || !getActiveTrack() || activeTrackRun || countdownRunning) return;
    countdownRunning = true;
      const hud = $('driveCountdownHud');
    setDisabled('countdownButton',true);
    const sequence = ['3','2','1','GO!'];
    let index = 0;
    const tick = () => {
      const value=sequence[index],isGo=value==='GO!',color=isGo?'#00f096':'#ff153d';
      hud.textContent=value;
      hud.setAttribute('fill',color); hud.setAttribute('stroke',color);
      hud.setAttribute('filter',isGo?'url(#signalGlow)':'url(#redGlow)');
      hud.style.display = 'inline';
      if (isGo) {
        startTrackRun(Date.now(),true,lastPosition);
        countdownTimer = setTimeout(() => { hud.style.display = 'none'; countdownRunning = false; updateLapView(); },700);
        return;
      }
      index++;
      countdownTimer = setTimeout(tick,1000);
    };
    tick();
  }
  bindButton('countdownButton',beginCountdown);

  let lastTrackTimeMs = 0;
  function renderLaps() {
    const list = $('lapList'); list.replaceChildren();
    const records=manualLapRecords.length?manualLapRecords:(showLegacyLapRecords?lapEntries:[]);
    if (!records.length) {
      list.append(textNode(120,625,'NO HAY VUELTAS REGISTRADAS','page-small'));
      return;
    }
    records.slice(-4).reverse().forEach((lap,index) => {
      const y = 625 + index * 28;
      list.append(textNode(125,y,'VUELTA ' + String(lap.number).padStart(2,'0'),'data-row-label'));
      list.append(textNode(1480,y,formatLap(lap.durationMs),'data-row-label','end'));
    });
  }
  function manualLapElapsed() { return manualLapElapsedMs + (lapRunning ? Date.now() - lapStartTime : 0); }
  function updateLapClock() {
    if (lapRunning) {
      $('lapClock').textContent = formatLap(manualLapElapsed());
      updateTrackViewClock();
    }
  }
  function updateLapStatus() {
    const track = getActiveTrack();
    $('lapAutoStatus').textContent = track
      ? 'TRACK GPS ACTIVO · ' + track.name + (activeTrackReverse ? ' · REVERSE' : '')
      : 'SELECCIONA UN TRACK PARA TRACK TIME';
  }
  function startLap() {
    if (lapRunning) return;
    lapRunning = true; lapStartTime = Date.now();
    clearInterval(lapTimer); lapTimer = setInterval(updateLapClock,30);
    setDisabled('lapStart',true); setDisabled('lapStop',false);
    updateLapClock();
  }
  function markLap() {
    if (!lapRunning) return;
    const elapsed = manualLapElapsed();
    const split = Math.max(0,elapsed - manualLapLastMarkMs);
    manualLapRecords.push({number:manualLapRecords.length + 1,durationMs:split});
    showLegacyLapRecords=false;
    writeStored('gpsDriveManualLaps',JSON.stringify(manualLapRecords));
    manualLapLastMarkMs = elapsed;
    renderLaps();
  }
  function stopLap() {
    if (!lapRunning) return;
    manualLapElapsedMs = manualLapElapsed(); lapRunning = false;
    clearInterval(lapTimer); lapTimer = null;
    $('lapClock').textContent = formatLap(manualLapElapsedMs);
    setDisabled('lapStart',false); setDisabled('lapStop',true);
  }
  function resetLap() {
    if (lapRunning) {
      manualLapElapsedMs = 0; lapRunning = false;
      clearInterval(lapTimer); lapTimer = null;
    }
    manualLapElapsedMs = 0; manualLapLastMarkMs = 0; manualLapRecords = [];
    showLegacyLapRecords=false;
    writeStored('gpsDriveManualLaps','[]');
    $('lapClock').textContent = '00:00.00';
    setDisabled('lapStart',false); setDisabled('lapStop',true);
    renderLaps();
  }
  bindButton('lapStart',startLap);
  bindButton('lapMark',markLap);
  bindButton('lapStop',stopLap);
  bindButton('lapReset',resetLap);
  bindButton('lapPanelTrackTab',() => showLapPanel(true));
  bindButton('lapPanelManualTab',() => showLapPanel(false));
  function showLapPanel(showTrack) {
    if (!showTrack && $('lapTrackOptions').style.display === 'inline') closeTrackDropdown('lap');
    $('trackTimePanel').style.display = showTrack ? 'inline' : 'none';
    $('manualLapPanel').style.display = showTrack ? 'none' : 'inline';
    $('lapPanelTrackTab').classList.toggle('is-active',showTrack);
    $('lapPanelManualTab').classList.toggle('is-active',!showTrack);
    $('lapPanelTrackTab').setAttribute('aria-pressed',String(showTrack));
    $('lapPanelManualTab').setAttribute('aria-pressed',String(!showTrack));
  }
  function getActiveRoute() {
    const track = getActiveTrack();
    if (!track || !Array.isArray(track.marks) || track.marks.length<2 || track.marks.some(mark => !mark || !Number.isFinite(Number(mark.latitude)) || !Number.isFinite(Number(mark.longitude)))) return [];
    const marks = activeTrackReverse ? [...track.marks].reverse() : [...track.marks];
    return marks.map((mark,index) => ({...mark,type:index === 0 ? 'START' : index === marks.length - 1 ? 'FINISH' : mark.type}));
  }
  function getRouteDistanceKm(route = getActiveRoute()) {
    return route.slice(1).reduce((sum,mark,index) => sum + calculateDistance(route[index],mark),0);
  }
  function routeProgressKm(position,route = getActiveRoute()) {
    if (route.length < 2) return 0;
    let best = {distance:Infinity,progress:0}, walked = 0;
    for (let i=0;i<route.length-1;i++) {
      const a=route[i],b=route[i+1],segment=calculateDistance(a,b);
      const latScale=Math.cos(radians((a.latitude+b.latitude)/2));
      const ax=a.longitude*latScale, ay=a.latitude, bx=b.longitude*latScale, by=b.latitude;
      const px=position.longitude*latScale, py=position.latitude;
      const dx=bx-ax,dy=by-ay,den=dx*dx+dy*dy||1;
      const t=clamp(((px-ax)*dx+(py-ay)*dy)/den,0,1);
      const lat=ay+dy*t,lon=(ax+dx*t)/latScale;
      const nearest={latitude:lat,longitude:lon};
      const distance=calculateDistance(position,nearest);
      if(distance<best.distance) best={distance,progress:walked+segment*t};
      walked+=segment;
    }
    return best.progress;
  }
  function updateTrackViewClock() {
    const run=activeTrackRun;
    const latest=getLatestTrackResult();
    const elapsed=run ? Math.max(0,Date.now()-run.startedAt) : (lastTrackTimeMs || Number(latest?.lapTimeMs) || 0);
    $('trackTimeClock').textContent=formatLap(elapsed);
  }
  function getLatestTrackResult() {
    const results=getActiveTrack()?.results;
    return Array.isArray(results)&&results.length?results[results.length-1]:null;
  }
  function renderTrackTimeStatus() {
    const track=getActiveTrack(),run=activeTrackRun;
    const record=run || getLatestTrackResult();
    $('lapAutoStatus').textContent=track ? (run
      ? (gpsFixAvailable?'MEDICIÓN EN CURSO · ':'GPS PERDIDO · VUELTA ABIERTA · ')+track.name
      : 'TRACK CARGADO · '+track.name) : 'SELECCIONA UN TRACK PARA TRACK TIME';
    const waiting=$('trackTimeWaiting');
    waiting.style.display=track && !run ? 'inline' : 'none';
    const list=$('trackTimeCheckpointList'); list.replaceChildren();
    const splits=record && Array.isArray(record.checkpointSplits) ? record.checkpointSplits : [];
    splits.forEach((cp,index)=>{
      const y=522+index*28;
      const row=makeSvg('g'); row.setAttribute('class','track-time-checkpoint-row');
      row.append(textNode(140,y,String(index+1).padStart(2,'0')+' · '+(cp.type||'CHECKPOINT'),'data-row-small'));
      row.append(textNode(1105,y,formatLap(Number(cp.elapsedMs)||0),'data-row-small','end'));
      const measured=Number(cp.speedKmh);
      row.append(textNode(1410,y,Number.isFinite(measured)?measured.toFixed(1)+' KM/H':'-- KM/H','data-row-small','end'));
      list.append(row);
    });
    updateTrackTimeScroller(splits.length*28+8);
    if(!run && record?.lapTimeMs) lastTrackTimeMs=Number(record.lapTimeMs)||lastTrackTimeMs;
    updateTrackViewClock();
  }
  function renderLapPanel() {
    updateLapStatus(); renderTrackTimeStatus(); renderTrackPickers(); updateLapView();
  }
  function updateLapView() {
    const track=getActiveTrack(),route=getActiveRoute();
    const title=$('trackViewTitle');
    title.textContent=track?'LAP TIME VIEW - '+track.name:'LAP TIME VIEW - CARGAR UN TRACK';
    if(track) { title.setAttribute('textLength','620'); title.setAttribute('lengthAdjust','spacingAndGlyphs'); }
    else { title.removeAttribute('textLength'); title.removeAttribute('lengthAdjust'); }
    $('trackViewStatus').textContent=!track?'CARGA UN TRACK PARA VER SU PROGRESO':
      activeTrackRun?(gpsFixAvailable?'TRACK TIME EN CURSO · GPS ACTIVO':'GPS PERDIDO · VUELTA ABIERTA'):
      gpsFixAvailable?'TRACK CARGADO · ESPERANDO START O COUNTDOWN':'ESPERANDO CONEXIÓN GPS';
    setDisabled('countdownButton',!track || !gpsFixAvailable || !!activeTrackRun || countdownRunning);
    setDisabled('reverseTrack',!track || !!activeTrackRun);
    setDisabled('lapTrackDeactivate',!track);
    const marks=$('trackProgressMarks'); marks.replaceChildren();
    const total=getRouteDistanceKm(route)||1;
    let cumulative=0;
    route.forEach((mark,index)=>{
      if(index) cumulative+=calculateDistance(route[index-1],mark);
      const x=445+1048*cumulative/total;
      const line=makeSvg('line'); line.setAttribute('x1',x);line.setAttribute('x2',x);line.setAttribute('y1','710');line.setAttribute('y2','734');line.setAttribute('stroke',index===0||index===route.length-1?'#ff3450':'#52bfff');line.setAttribute('stroke-width','2');marks.append(line);
      if(index===0||index===route.length-1){const label=textNode(x,index===0?704:704,mark.type,'data-row-small','middle');marks.append(label);}
    });
    const latest=getLatestTrackResult();
    let progress=0;
    if(activeTrackRun) progress=activeTrackRun.progressKm;
    else if(gpsActive&&lastPosition) progress=routeProgressKm(lastPosition,route);
    else if(latest?.telemetry?.length) {
      const sample=latest.telemetry[latest.telemetry.length-1];
      progress=Number.isFinite(Number(sample.routeProgressKm))?Number(sample.routeProgressKm):routeProgressKm(sample,route);
    }
    const ratio=clamp(progress/total,0,1),x=445+1048*ratio;
    $('trackProgressFill').setAttribute('d','M445 722H'+x);
    $('trackProgressPointer').setAttribute('d','M'+x+' 702 '+(x-10)+' 688 '+(x+10)+' 688Z');
    const lapX=1120+340*ratio;
    $('lapTrackProgressFill').setAttribute('d','M1120 378H'+lapX);
    $('lapTrackProgressPointer').setAttribute('d','M'+lapX+' 367 '+(lapX-8)+' 355 '+(lapX+8)+' 355Z');
    $('trackViewProgress').textContent=Math.round(ratio*100)+'%';
    const latestSplit=latest?.checkpointSplits?.[latest.checkpointSplits.length-1];
    $('trackViewMean').textContent='MEDIA TRAMO: '+Math.round(activeTrackRun?.currentSegmentAverageKmh||latestSplit?.averageSpeedKmh||0)+' KM/H';
    $('trackTimeLive').textContent='GPS · '+speed.toFixed(1)+' KM/H';
    $('trackTimeSummary').textContent='MEDIA DE TRAMO · '+Math.round(activeTrackRun?.currentSegmentAverageKmh||latestSplit?.averageSpeedKmh||0)+' KM/H';
    $('trackTimeWaiting').style.display=track && !activeTrackRun ? 'inline' : 'none';
    updateTrackTimeScroller((activeTrackRun?.checkpointSplits||latest?.checkpointSplits||[]).length*28+8);
    updateTrackViewClock();
  }

  const trackTimeScroller={offset:0,maxOffset:0,rowHeight:28,top:500,bottom:644,x:1448,viewportHeight:147,contentHeight:147};
  function setTrackTimeScroll(value) {
    const state=trackTimeScroller;
    state.offset=clamp(value,0,state.maxOffset);
    $('trackTimeCheckpointList').setAttribute('transform','translate(0 '+(-state.offset)+')');
    updateTrackTimeScroller();
  }
  function updateTrackTimeScroller(totalHeight) {
    const state=trackTimeScroller;
    if(totalHeight!==undefined) state.contentHeight=Math.max(state.viewportHeight,totalHeight);
    state.maxOffset=Math.max(0,state.contentHeight-state.viewportHeight);
    state.offset=clamp(state.offset,0,state.maxOffset);
    $('trackTimeCheckpointList').setAttribute('transform','translate(0 '+(-state.offset)+')');
    const trackHeight=state.bottom-state.top;
    const thumbHeight=state.maxOffset?Math.max(22,trackHeight*state.viewportHeight/state.contentHeight):trackHeight;
    const thumbY=state.top+(state.maxOffset?state.offset/state.maxOffset*(trackHeight-thumbHeight):0);
    const thumb=$('trackTimeScrollThumb');
    thumb.setAttribute('d','M'+state.x+' '+thumbY+'V'+(thumbY+thumbHeight));
    thumb.setAttribute('aria-valuemax',String(Math.ceil(state.maxOffset)));
    thumb.setAttribute('aria-valuenow',String(Math.round(state.offset)));
  }
  function setupTrackTimeScroller() {
    const viewport=$('trackTimeCheckpointViewport'),thumb=$('trackTimeScrollThumb');
    const drag={startY:0,startOffset:0,active:false};
    viewport.addEventListener('wheel',event=>{event.preventDefault();setTrackTimeScroll(trackTimeScroller.offset+event.deltaY);},{passive:false});
    thumb.addEventListener('keydown',event=>{
      const step=trackTimeScroller.rowHeight;
      if(event.key==='ArrowDown'||event.key==='ArrowRight')setTrackTimeScroll(trackTimeScroller.offset+step);
      else if(event.key==='ArrowUp'||event.key==='ArrowLeft')setTrackTimeScroll(trackTimeScroller.offset-step);
      else if(event.key==='Home')setTrackTimeScroll(0);
      else if(event.key==='End')setTrackTimeScroll(trackTimeScroller.maxOffset);
      else return;
      event.preventDefault();
    });
    thumb.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();const point=svgPointFromEvent(event);drag.startY=point?point.y:event.clientY;drag.startOffset=trackTimeScroller.offset;drag.active=true;if(thumb.setPointerCapture)thumb.setPointerCapture(event.pointerId);});
    thumb.addEventListener('pointermove',event=>{if(!drag.active)return;const point=svgPointFromEvent(event),y=point?point.y:event.clientY;const range=(trackTimeScroller.bottom-trackTimeScroller.top)-Math.max(22,(trackTimeScroller.bottom-trackTimeScroller.top)*trackTimeScroller.viewportHeight/trackTimeScroller.contentHeight);if(range>0)setTrackTimeScroll(drag.startOffset+(y-drag.startY)/range*trackTimeScroller.maxOffset);});
    thumb.addEventListener('pointerup',()=>{drag.active=false;});thumb.addEventListener('pointercancel',()=>{drag.active=false;});
    updateTrackTimeScroller();
  }

  const trackScrollers = {
    draft:{viewport:'trackDraftViewport',content:'trackDraftContent',thumb:'trackDraftScrollThumb',top:401,bottom:678,x:519,viewportHeight:281,rowHeight:36,offset:0},
    list:{viewport:'trackListViewport',content:'trackListContent',thumb:'trackListScrollThumb',top:373,bottom:707,x:1028,viewportHeight:336,rowHeight:58,offset:0},
    results:{viewport:'trackResultsViewport',content:'trackResultsContent',thumb:'trackResultsScrollThumb',top:411,bottom:707,x:1524,viewportHeight:297,rowHeight:46,offset:0}
  };

  function bindListAction(element,handler) {
    element.addEventListener('click',event => { event.preventDefault(); event.stopPropagation(); handler(event); });
    element.addEventListener('keydown',event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation(); handler(event);
    });
  }
  function setScrollerOffset(name,value) {
    const state = trackScrollers[name];
    state.offset = clamp(value,0,state.maxOffset);
    $(state.content).setAttribute('transform','translate(0 ' + -state.offset + ')');
    updateScrollerThumb(name);
  }
  function updateScrollerThumb(name,totalHeight) {
    const state = trackScrollers[name];
    if (totalHeight !== undefined) state.contentHeight = totalHeight;
    state.contentHeight = Math.max(state.viewportHeight,state.contentHeight || state.viewportHeight);
    state.maxOffset = Math.max(0,state.contentHeight - state.viewportHeight);
    state.offset = clamp(state.offset,0,state.maxOffset);
    $(state.content).setAttribute('transform','translate(0 ' + -state.offset + ')');
    const trackHeight = state.bottom - state.top;
    const thumbHeight = state.maxOffset ? Math.max(28,trackHeight * state.viewportHeight / state.contentHeight) : trackHeight;
    const thumbY = state.top + (state.maxOffset ? state.offset / state.maxOffset * (trackHeight - thumbHeight) : 0);
    $(state.thumb).setAttribute('d','M' + state.x + ' ' + thumbY + 'V' + (thumbY + thumbHeight));
    $(state.thumb).setAttribute('aria-valuemax',String(Math.ceil(state.maxOffset)));
    $(state.thumb).setAttribute('aria-valuenow',String(Math.round(state.offset)));
  }
  function setupTrackScrollers() {
    Object.entries(trackScrollers).forEach(([name,state]) => {
      const viewport = $(state.viewport), thumb = $(state.thumb);
      const drag = {startY:0,startOffset:0,active:false,moved:false,ignoreClick:false,thumbOffset:0};
      viewport.addEventListener('wheel',event => {
        event.preventDefault(); setScrollerOffset(name,state.offset + event.deltaY);
      },{passive:false});
      viewport.addEventListener('pointerdown',event => {
        if (event.target === thumb) return;
        const point = svgPointFromEvent(event);
        drag.startY = point ? point.y : event.clientY; drag.startOffset = state.offset; drag.active = true; drag.moved = false;
        if (event.target && event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId);
      });
      viewport.addEventListener('pointermove',event => {
        if (!drag.active) return;
        const point = svgPointFromEvent(event);
        const y = point ? point.y : event.clientY;
        const delta = drag.startY - y;
        if (Math.abs(delta) < 5 && !drag.moved) return;
        drag.moved = true;
        setScrollerOffset(name,drag.startOffset + delta);
        event.preventDefault();
      });
      viewport.addEventListener('pointerup',() => {
        if (drag.moved) {
          drag.ignoreClick = true;
          setTimeout(() => { drag.ignoreClick = false; },500);
        }
        drag.active = false;
      });
      viewport.addEventListener('pointercancel',() => { drag.active = false; });
      viewport.addEventListener('click',event => {
        if (!drag.ignoreClick) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); drag.ignoreClick = false;
      },true);
      thumb.addEventListener('pointerdown',event => {
        event.preventDefault(); event.stopPropagation();
        const point = svgPointFromEvent(event);
        drag.startY = point ? point.y : event.clientY; drag.startOffset = state.offset; drag.active = true; drag.moved = false; drag.thumbOffset = state.offset;
        if (thumb.setPointerCapture) thumb.setPointerCapture(event.pointerId);
      });
      thumb.addEventListener('pointermove',event => {
        if (!drag.active) return;
        const point = svgPointFromEvent(event);
        const y = point ? point.y : event.clientY;
        const trackHeight = state.bottom - state.top;
        const thumbLength = trackHeight - (state.maxOffset ? state.maxOffset / state.contentHeight * trackHeight : 0);
        const scrollRange = trackHeight - thumbLength;
        if (!scrollRange) return;
        const startPoint = point ? drag.startY : drag.startY;
        const delta = y - startPoint;
        if (Math.abs(delta) < 2 && !drag.moved) return;
        drag.moved = true;
        setScrollerOffset(name,drag.startOffset + delta / scrollRange * state.maxOffset);
      });
      thumb.addEventListener('pointerup',() => { drag.active = false; });
      thumb.addEventListener('pointercancel',() => { drag.active = false; });
      thumb.addEventListener('keydown',event => {
        const step = state.rowHeight;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') setScrollerOffset(name,state.offset + step);
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') setScrollerOffset(name,state.offset - step);
        else if (event.key === 'Home') setScrollerOffset(name,0);
        else if (event.key === 'End') setScrollerOffset(name,state.maxOffset);
        else return;
        event.preventDefault();
      });
      updateScrollerThumb(name,state.viewportHeight);
    });
  }
  function getActiveTrack() { return tracks.find(track => track.id === activeTrackId) || null; }
  function getTrackDistanceKm(track) {
    if (!Array.isArray(track.marks) || track.marks.length<2) return 0;
    return track.marks.slice(1).reduce((sum,mark,index) => {
      const previous=track.marks[index];
      return Number.isFinite(Number(mark.latitude))&&Number.isFinite(Number(mark.longitude))&&
        Number.isFinite(Number(previous.latitude))&&Number.isFinite(Number(previous.longitude))
        ? sum+calculateDistance(previous,mark):sum;
    },0);
  }
  function saveTracks() {
    if (!tracksStorageWritable) {
      $('trackDraftFeedback').textContent='DATOS DE TRACK NO LEGIBLES · GUARDADO BLOQUEADO';
      return false;
    }
    writeStored('gpsDriveTracks',JSON.stringify(tracks));
    writeStored('gpsDriveNextTrackNumber',String(nextTrackNumber));
    renderTrackList(); renderTrackResults(); renderTrackPickers(); updateLapStatus(); updateSettingsView(); updateLapView();
    return true;
    if ($('lapTrackOptions').style.display === 'inline') renderTrackDropdown('lap');
    if ($('resultsFilterOptions').style.display === 'inline') renderTrackDropdown('results');
  }
  function captureTrackMark() {
    if (!lastPosition || activeSource !== 'gps') {
      $('trackDraftFeedback').textContent = 'ACTIVA GPS REAL PARA REGISTRAR';
      return;
    }
    const index = draftMarks.length;
    if (index >= 2) {
      draftMarks[index - 1].type = 'CHECKPOINT#' + (index - 1);
      draftMarks[index - 1].isCheckpoint = true;
    }
    draftMarks.push({
      type:index === 0 ? 'START' : 'FINISH',
      isCheckpoint:false,
      latitude:lastPosition.latitude,longitude:lastPosition.longitude,
      altitude:lastPosition.altitude,accuracy:lastPosition.accuracy,
      timestamp:lastPosition.timestamp || Date.now(),gpsTimestamp:lastPosition.timestamp
    });
    $('trackDraftFeedback').textContent = 'MARCA REGISTRADA · ' + draftMarks[draftMarks.length - 1].type;
    renderTrackDraft();
  }
  function removeLastTrackMark() {
    if (!draftMarks.length) return;
    draftMarks.pop();
    if (draftMarks.length === 1) draftMarks[0].type = 'START';
    else if (draftMarks.length > 1) {
      draftMarks[draftMarks.length - 1].type = 'FINISH';
      draftMarks[draftMarks.length - 1].isCheckpoint = false;
    }
    $('trackDraftFeedback').textContent = draftMarks.length ? 'ÚLTIMA MARCA BORRADA' : 'BORRADOR VACÍO';
    renderTrackDraft();
  }
  function renderTrackDraft() {
    const content = $('trackDraftContent'); content.replaceChildren();
    if (!draftMarks.length) content.append(textNode(96,448,'ESPERANDO MARCAS GPS REALES','page-small'));
    draftMarks.forEach((mark,index) => {
      const y = 424 + index * trackScrollers.draft.rowHeight;
      const label = textNode(96,y,mark.type,'data-row-label' + (mark.isCheckpoint ? ' interactive draft-checkpoint-name' : ''));
      if (mark.isCheckpoint) {
        label.setAttribute('id','draftCheckpointName-' + index); label.setAttribute('role','button'); label.setAttribute('tabindex','0');
        label.setAttribute('aria-label','Editar nombre del checkpoint ' + mark.type); label.setAttribute('data-keyboard-type','alphanumeric');
        label.setAttribute('textLength','190'); label.setAttribute('lengthAdjust','spacingAndGlyphs');
        bindListAction(label,() => openConfigurationKeyboard(label,{
          value:mark.type,
          validate:value => !value.trim() ? 'EL NOMBRE NO PUEDE ESTAR VACÍO' : value.trim().length > 32 ? 'MÁXIMO 32 CARACTERES' : '',
          commit:value => { mark.type = value.trim(); $('trackDraftFeedback').textContent = 'CHECKPOINT RENOMBRADO'; renderTrackDraft(); }
        }));
      }
      content.append(label);
      content.append(textNode(502,y,'GPS · ' + formatStamp(mark.timestamp),'data-row-small','end'));
      if (index < draftMarks.length - 1) {
        const line = makeSvg('path'); line.setAttribute('d','M92 ' + (y + 10) + 'H506'); line.setAttribute('class','page-separator'); content.append(line);
      }
    });
    $('draftMarkCount').textContent = draftMarks.length + ' MARCAS' + (draftMarks.length < 2 ? ' · NECESITAS 2' : ' · LISTO PARA CREAR');
    setDisabled('createTrack',draftMarks.length < 2);
    setDisabled('removeTrackMark',draftMarks.length === 0);
    updateScrollerThumb('draft',Math.max(trackScrollers.draft.viewportHeight,draftMarks.length * trackScrollers.draft.rowHeight + 30));
  }
  function renderTrackList() {
    const content = $('trackListContent'); content.replaceChildren();
    if (!tracks.length) content.append(textNode(594,411,'AÚN NO HAY TRACKS','page-small'));
    tracks.forEach((track,index) => {
      const y = 397 + index * trackScrollers.list.rowHeight;
      const row = makeSvg('g'); row.setAttribute('class','track-row' + (track.id === activeTrackId ? ' is-selected' : ''));
      if (track.id === activeTrackId) {
        const bg = makeSvg('path'); bg.setAttribute('d','M584 ' + (y - 22) + 'H1014V' + (y + 31) + 'H584Z'); bg.setAttribute('class','track-row-highlight'); row.append(bg);
      }
      const name = textNode(596,y,track.name,'track-name interactive');
      name.setAttribute('id','track-name-' + track.id); name.setAttribute('role','button'); name.setAttribute('tabindex','0');
      name.setAttribute('aria-label','Renombrar ' + track.name); name.setAttribute('data-keyboard-type','alphanumeric'); name.setAttribute('data-keyboard-label','NOMBRE DEL TRACK');
      name.setAttribute('textLength','272'); name.setAttribute('lengthAdjust','spacingAndGlyphs'); row.append(name);
      row.append(textNode(596,y + 22,track.marks.length + ' MARCAS · ' + getTrackDistanceKm(track).toFixed(2) + ' KM','data-row-small'));
      const use = makeSvg('g'); use.setAttribute('id','track-use-' + track.id); use.setAttribute('class','interactive track-use-button'); use.setAttribute('role','button'); use.setAttribute('tabindex','0'); use.setAttribute('aria-label','Cargar ' + track.name + ' en Lap Time');
      const shape = makeSvg('path'); shape.setAttribute('d','M927 ' + (y - 18) + 'H1018L1008 ' + (y + 10) + 'H917Z'); shape.setAttribute('class','track-use-shape');
      const label = textNode(967,y + 2,track.id === activeTrackId ? 'DESACTIVAR' : 'ACTIVAR','track-use-label','middle'); use.append(shape,label); row.append(use);
      bindListAction(name,() => openConfigurationKeyboard(name,{
        value:track.name,
        validate:value => {
          const clean = value.trim();
          if (!clean) return 'EL NOMBRE NO PUEDE ESTAR VACÍO';
          if (clean.length > 32) return 'MÁXIMO 32 CARACTERES';
          if (tracks.some(other => other.id !== track.id && other.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) return 'ESE NOMBRE YA EXISTE';
          return '';
        },
        commit:value => {
          track.name = value.trim();
          const sequenceMatch = track.name.match(/^TRACK\s*#(\d+)$/i);
          if (sequenceMatch) nextTrackNumber = Math.max(nextTrackNumber,Number(sequenceMatch[1]) + 1);
          saveTracks();
        }
      }));
      use.setAttribute('aria-label',track.id === activeTrackId ? 'Desactivar ' + track.name + ' de Lap Time' : 'Activar ' + track.name + ' en Lap Time');
      bindListAction(use,() => track.id === activeTrackId ? openTrackConfirmation(track) : selectTrack(track.id));
      content.append(row);
      if (index < tracks.length - 1) {
        const line = makeSvg('path'); line.setAttribute('d','M590 ' + (y + 33) + 'H1018'); line.setAttribute('class','page-separator'); content.append(line);
      }
    });
    updateScrollerThumb('list',Math.max(trackScrollers.list.viewportHeight,tracks.length * trackScrollers.list.rowHeight));
  }
  function renderTrackResults() {
    const content = $('trackResultsContent'); content.replaceChildren();
    const score = result => {
      const distance = Number(result.routeDistanceKm) || 0;
      const time = Number(result.lapTimeMs) || 0;
      return time > 0 ? distance / time : 0;
    };
    let rows;
    if (resultsFilterId === 'best') {
      rows = tracks.map(track => ({track,result:(track.results || []).filter(result => result.completed !== false)
        .slice().sort((a,b) => score(b) - score(a))[0] || null}))
        .filter(row => row.result)
        .sort((a,b) => score(b.result) - score(a.result) || a.track.number - b.track.number);
    } else {
      const track = tracks.find(item => item.id === resultsFilterId);
      rows = track ? (track.results || []).map(result => ({track,result}))
        .sort((a,b) => Number(b.result.completed !== false) - Number(a.result.completed !== false) || score(b.result) - score(a.result)) : [];
    }
    if (!rows.length) content.append(textNode(1092,452,tracks.length ? 'SIN RESULTADOS PARA ESTE FILTRO' : 'SIN TRACKS REGISTRADOS','page-small'));
    rows.forEach(({track,result},index) => {
      const y = 438 + index * trackScrollers.results.rowHeight;
      const isIncomplete = result.completed === false;
      const name = textNode(1092,y,track.name + (isIncomplete ? ' · INCOMPLETO' : ''),isIncomplete ? 'data-row-label result-incomplete' : 'data-row-label');
      name.setAttribute('textLength','232'); name.setAttribute('lengthAdjust','spacingAndGlyphs'); content.append(name);
      content.append(textNode(1360,y,Number(result.routeDistanceKm || 0).toFixed(2),isIncomplete ? 'data-row-label result-incomplete' : 'data-row-label','middle'));
      content.append(textNode(1500,y,formatTrackClock(result.lapTimeMs),isIncomplete ? 'data-row-label result-incomplete' : 'data-row-label','end'));
      if (index < rows.length - 1) {
        const line = makeSvg('path'); line.setAttribute('d','M1088 ' + (y + 12) + 'H1516'); line.setAttribute('class','page-separator'); content.append(line);
      }
    });
    updateScrollerThumb('results',Math.max(trackScrollers.results.viewportHeight,rows.length * trackScrollers.results.rowHeight + 28));
    renderResultFilterLabel();
  }
  const dropdownConfig = {
    lap:{group:'lapTrackOptions',clip:'url(#lapTrackOptionsClip)',x:105,y:365,width:477,height:330,rowHeight:36,kind:'lap'},
    results:{group:'resultsFilterOptions',clip:'url(#resultsFilterOptionsClip)',x:1088,y:376,width:428,height:330,rowHeight:34,kind:'results'}
  };
  function closeTrackDropdown(kind) {
    const config = dropdownConfig[kind];
    $(config.group).style.display = 'none'; $(config.group).setAttribute('aria-hidden','true');
    $(kind === 'lap' ? 'lapTrackSelect' : 'resultsFilter').setAttribute('aria-expanded','false');
  }
  function renderResultFilterLabel() {
    const track = tracks.find(item => item.id === resultsFilterId);
    $('resultsFilterLabel').textContent = resultsFilterId === 'best' ? 'MEJOR VUELTA' : track ? track.name : 'MEJOR VUELTA';
  }
  function renderTrackPickers() {
    const track = tracks.find(item => item.id === selectedLapPickerId);
    $('lapTrackSelectLabel').textContent = track ? track.name : 'SELECCIONAR TRACK';
    $('lapTrackSelectLabel').setAttribute('textLength','270'); $('lapTrackSelectLabel').setAttribute('lengthAdjust','spacingAndGlyphs');
    setDisabled('lapTrackLoad',!track);
    $('lapTrackLoad').setAttribute('aria-label',track ? 'Cargar ' + track.name + ' en Lap Time' : 'Selecciona un track para cargar');
    renderResultFilterLabel();
  }
  function renderTrackDropdown(kind) {
    const config = dropdownConfig[kind], group = $(config.group);
    group.replaceChildren(); group.setAttribute('clip-path',config.clip);
    const backdrop = makeSvg('path');
    backdrop.setAttribute('d','M' + config.x + ' ' + config.y + 'H' + (config.x + config.width - 10) + 'L' + (config.x + config.width) + ' ' + (config.y + 10) + 'V' + (config.y + config.height - 8) + 'L' + (config.x + config.width - 8) + ' ' + (config.y + config.height) + 'H' + config.x + 'Z');
    backdrop.setAttribute('class','track-dropdown-backdrop'); group.append(backdrop);
    const content = makeSvg('g'); content.setAttribute('class','track-dropdown-content'); group.append(content);
    let options;
    if (kind === 'lap') options = tracks.map(track => ({id:track.id,label:track.name,action:() => {
      selectedLapPickerId = track.id; renderTrackPickers(); closeTrackDropdown('lap');
    }}));
    else options = [{id:'best',label:'MEJOR VUELTA',action:() => {
      resultsFilterId = 'best'; closeTrackDropdown('results'); renderTrackResults();
    }}].concat(tracks.map(track => ({id:track.id,label:track.name,action:() => {
      resultsFilterId = track.id; closeTrackDropdown('results'); renderTrackResults();
    }})));
    if (!options.length) content.append(textNode(config.x + 18,config.y + 34,'NO HAY TRACKS REGISTRADOS','page-small'));
    options.forEach((option,index) => {
      const rowY = config.y + 5 + index * config.rowHeight;
      const item = makeSvg('g'); item.setAttribute('class','interactive track-dropdown-option'); item.setAttribute('role','button'); item.setAttribute('tabindex','0');
      const selected = kind === 'lap' ? option.id === selectedLapPickerId : option.id === resultsFilterId;
      const shape = makeSvg('path');
      shape.setAttribute('d','M' + (config.x + 5) + ' ' + rowY + 'H' + (config.x + config.width - 10) + 'V' + (rowY + config.rowHeight - 2) + 'H' + (config.x + 5) + 'Z');
      shape.setAttribute('class','track-dropdown-option-shape' + (selected ? ' is-current' : '')); item.append(shape);
      const label = textNode(config.x + 16,rowY + config.rowHeight * .69,option.label,'track-dropdown-option-label');
      label.setAttribute('textLength',config.width - 46); label.setAttribute('lengthAdjust','spacingAndGlyphs'); item.append(label);
      bindListAction(item,option.action); content.append(item);
    });
    const state = dropdownStates[kind];
    const visible = config.height - 12;
    const total = Math.max(visible,options.length * config.rowHeight + 8);
    state.maxOffset = Math.max(0,total - visible); state.offset = clamp(state.offset,0,state.maxOffset);
    content.setAttribute('transform','translate(0 ' + -state.offset + ')');
    const trackHeight = config.height - 18, thumbHeight = state.maxOffset ? Math.max(25,trackHeight * visible / total) : trackHeight;
    const thumb = makeSvg('path'); thumb.setAttribute('d','M' + (config.x + config.width - 5) + ' ' + (config.y + 8) + 'V' + (config.y + 8 + thumbHeight));
    thumb.setAttribute('class','track-dropdown-scroll'); group.append(thumb);
    state.content = content; state.thumb = thumb; state.config = config;
  }
  function openTrackDropdown(kind) {
    const config = dropdownConfig[kind];
    renderTrackDropdown(kind);
    $(config.group).style.display = 'inline'; $(config.group).setAttribute('aria-hidden','false');
    $(kind === 'lap' ? 'lapTrackSelect' : 'resultsFilter').setAttribute('aria-expanded','true');
  }
  function setDropdownOffset(kind,value) {
    const state = dropdownStates[kind], config = dropdownConfig[kind];
    state.offset = clamp(value,0,state.maxOffset);
    if (state.content) state.content.setAttribute('transform','translate(0 ' + -state.offset + ')');
    if (state.thumb) {
      const visible = config.height - 12, total = visible + state.maxOffset;
      const trackHeight = config.height - 18, thumbHeight = state.maxOffset ? Math.max(25,trackHeight * visible / total) : trackHeight;
      const y = config.y + 8 + (state.maxOffset ? state.offset / state.maxOffset * (trackHeight - thumbHeight) : 0);
      state.thumb.setAttribute('d','M' + (config.x + config.width - 5) + ' ' + y + 'V' + (y + thumbHeight));
    }
  }
  function setupDropdownInteractions() {
    Object.keys(dropdownConfig).forEach(kind => {
      const group = $(dropdownConfig[kind].group), state = dropdownStates[kind];
      state.drag = {startY:0,startOffset:0,moved:false,active:false,suppressClick:false};
      group.addEventListener('wheel',event => { event.preventDefault(); setDropdownOffset(kind,state.offset + event.deltaY); },{passive:false});
      group.addEventListener('pointerdown',event => {
        const point = svgPointFromEvent(event); state.drag.startY = point ? point.y : event.clientY;
        state.drag.startOffset = state.offset; state.drag.moved = false; state.drag.active = true;
        if (event.target && event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId);
      });
      group.addEventListener('pointermove',event => {
        if (!state.drag.active) return;
        const point = svgPointFromEvent(event), y = point ? point.y : event.clientY;
        const delta = state.drag.startY - y;
        if (Math.abs(delta) < 4 && !state.drag.moved) return;
        state.drag.moved = true; setDropdownOffset(kind,state.drag.startOffset + delta); event.preventDefault();
      });
      group.addEventListener('pointerup',() => {
        state.drag.active = false;
        if (state.drag.moved) { state.drag.suppressClick = true; setTimeout(() => { state.drag.suppressClick = false; },400); }
      });
      group.addEventListener('pointercancel',() => { state.drag.active = false; });
      group.addEventListener('click',event => {
        if (!state.drag.suppressClick) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.drag.suppressClick = false;
      },true);
    });
    bindButton('lapTrackSelect',() => {
      if ($('lapTrackOptions').style.display === 'inline') closeTrackDropdown('lap'); else openTrackDropdown('lap');
    });
    bindButton('lapTrackLoad',() => { if (tracks.some(track => track.id === selectedLapPickerId)) selectTrack(selectedLapPickerId,false); });
    bindButton('reverseTrack',() => { if (tracks.some(track => track.id === selectedLapPickerId)) selectTrack(selectedLapPickerId,true); });
    bindButton('lapTrackDeactivate',() => { const track=getActiveTrack(); if(track) openTrackConfirmation(track); });
    bindButton('resultsFilter',() => {
      if ($('resultsFilterOptions').style.display === 'inline') closeTrackDropdown('results'); else openTrackDropdown('results');
    });
  }
  function persistNewTrack() {
    if (!tracksStorageWritable) {
      $('trackDraftFeedback').textContent='DATOS DE TRACK NO LEGIBLES · GUARDADO BLOQUEADO';
      return;
    }
    if (draftMarks.length < 2) return;
    const number = nextTrackNumber++;
    tracks.push({
      id:'track-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),number,
      name:'TRACK #' + number,createdAt:Date.now(),
      marks:draftMarks.map(mark => ({...mark})),results:[]
    });
    draftMarks = [];
    $('trackDraftFeedback').textContent = activeSource === 'gps' ? 'TRACK GUARDADO · PUEDES REGISTRAR OTRO' : 'TRACK GUARDADO · GPS DESCONECTADO';
    selectedLapPickerId = tracks[tracks.length - 1].id;
    saveTracks(); renderTrackDraft();
  }
  function selectTrack(id,reverse = false) {
    const track = tracks.find(item => item.id === id);
    if (!track) return;
    if (id === activeTrackId && reverse === activeTrackReverse) { selectedLapPickerId = id; renderTrackPickers(); return; }
    if (activeTrackId && activeTrackRun) {
      openTrackConfirmation(getActiveTrack(),id,reverse); return;
    }
    activeTrackRun = null; trackStartNearby = false; trackFinishNearby = false;
    lastTrackTimeMs=0;
    activeTrackId = id; activeTrackReverse=reverse; selectedLapPickerId = id;
    writeStored('gpsDriveSelectedTrack',id); writeStored('gpsDriveTrackReversed',String(reverse));
    renderTrackList(); renderTrackPickers(); updateLapStatus(); updateSettingsView(); updateLapView(); renderTrackTimeStatus();
  }
  function openTrackConfirmation(track,nextTrackId = '',nextTrackReverse = false) {
    pendingTrackConfirmation = {trackId:track ? track.id : activeTrackId,nextTrackId,nextTrackReverse};
    const message = $('trackConfirmMessage');
    message.textContent = '¿Seguro que quieres terminar ' + (track ? track.name : 'este TRACK') + '?';
    message.setAttribute('textLength','970'); message.setAttribute('lengthAdjust','spacingAndGlyphs');
    $('trackConfirmDialog').style.display = 'inline'; $('trackConfirmDialog').setAttribute('aria-hidden','false');
  }
  function closeTrackConfirmation() {
    $('trackConfirmDialog').style.display = 'none'; $('trackConfirmDialog').setAttribute('aria-hidden','true');
    pendingTrackConfirmation = null;
  }
  function finishTrackConfirmation(saveIncomplete,keepTrackLoaded = false) {
    if (!pendingTrackConfirmation) return;
    const track = tracks.find(item => item.id === pendingTrackConfirmation.trackId);
    const nextTrackId = pendingTrackConfirmation.nextTrackId;
    const nextTrackReverse = pendingTrackConfirmation.nextTrackReverse;
    const run = activeTrackRun && activeTrackRun.trackId === (track && track.id) ? activeTrackRun : null;
    if (saveIncomplete && run && track) {
      const endedAt = Math.max(lastPosition ? lastPosition.timestamp : 0,Date.now());
      const lastSample = run.samples[run.samples.length - 1];
      const durationMs = Math.max(0,endedAt - run.startedAt);
      track.results = [...(track.results || []),{
        id:'result-incomplete-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
        completed:false,startedAt:run.startedAt,endedAt,lapTimeMs:durationMs,
        routeDistanceKm:lastSample ? lastSample.distanceKm : run.distanceKm,
        maxSpeed:run.maxSpeed,averageSpeed:durationMs ? run.distanceKm / (durationMs / 3600000) : 0,
        telemetry:run.samples,checkpointSplits:run.checkpointSplits,reverse:run.reverse
      }];
    }
    activeTrackRun = null; trackStartNearby = false; trackFinishNearby = false;
    lastTrackTimeMs=run?Math.max(0,Date.now()-run.startedAt):lastTrackTimeMs;
    clearInterval(trackClockTimer); trackClockTimer=null;
    lastTrackTimeMs=0;
    if(keepTrackLoaded && track) {
      activeTrackId=track.id; activeTrackReverse=run ? run.reverse : activeTrackReverse; selectedLapPickerId=track.id;
      writeStored('gpsDriveSelectedTrack',track.id); writeStored('gpsDriveTrackReversed',String(activeTrackReverse));
    } else {
      activeTrackId=''; writeStored('gpsDriveSelectedTrack','');
    }
    closeTrackConfirmation();
    if (track && saveIncomplete && run) saveTracks();
    else { renderTrackList(); renderTrackResults(); renderTrackPickers(); updateLapStatus(); updateSettingsView(); updateLapView(); }
    if (nextTrackId && (nextTrackId !== track?.id || nextTrackReverse !== activeTrackReverse)) selectTrack(nextTrackId,nextTrackReverse);
  }
  bindButton('trackConfirmContinue',closeTrackConfirmation);
  bindButton('trackConfirmFinish',() => finishTrackConfirmation(true,false));
  bindButton('trackConfirmSave',() => finishTrackConfirmation(true,true));
  $('trackConfirmDialog').addEventListener('keydown',event => {
    if (event.key === 'Escape') { event.preventDefault(); closeTrackConfirmation(); }
  });
  bindButton('addTrackMark',captureTrackMark);
  bindButton('removeTrackMark',removeLastTrackMark);
  bindButton('createTrack',persistNewTrack);

  function distanceFromTrackMarkKm(mark,position) { return calculateDistance(mark,position); }
  function distanceToPositionSegmentM(mark,previous,position) {
    if (!previous) return distanceFromTrackMarkKm(mark,position)*1000;
    const latitudeScale=111320;
    const longitudeScale=111320*Math.cos(radians((mark.latitude+previous.latitude+position.latitude)/3));
    const ax=previous.longitude*longitudeScale,ay=previous.latitude*latitudeScale;
    const bx=position.longitude*longitudeScale,by=position.latitude*latitudeScale;
    const px=mark.longitude*longitudeScale,py=mark.latitude*latitudeScale;
    const dx=bx-ax,dy=by-ay,denominator=dx*dx+dy*dy||1;
    const progress=clamp(((px-ax)*dx+(py-ay)*dy)/denominator,0,1);
    return Math.hypot(px-(ax+dx*progress),py-(ay+dy*progress));
  }
  function passedTrackMark(mark,previous,position) {
    return distanceFromTrackMarkKm(mark,position)*1000<=checkpointRadius ||
      distanceToPositionSegmentM(mark,previous,position)<=checkpointRadius;
  }
  function appendTrackTelemetry(position,timestamp) {
    if (!activeTrackRun) return;
    const route=getActiveRoute();
    const measuredSpeed=position.speed == null ? speed : Number(position.speed);
    activeTrackRun.maxSpeed=Math.max(activeTrackRun.maxSpeed,measuredSpeed);
    const previous=activeTrackRun.samples[activeTrackRun.samples.length-1];
    if(previous && previous.timestamp===timestamp && previous.latitude===position.latitude && previous.longitude===position.longitude) return;
    const sample={timestamp,latitude:position.latitude,longitude:position.longitude,altitude:position.altitude,
      accuracy:position.accuracy,speedKmh:measuredSpeed,distanceKm:activeTrackRun.distanceKm,
      routeProgressKm:routeProgressKm(position,route)};
    activeTrackRun.progressKm=Math.max(activeTrackRun.progressKm,sample.routeProgressKm);
    activeTrackRun.samples.push(sample);
    const elapsed=Math.max(0,timestamp-activeTrackRun.lastCheckpointAt);
    const segmentDistance=Math.max(0,activeTrackRun.distanceKm-activeTrackRun.lastCheckpointDistanceKm);
    activeTrackRun.currentSegmentAverageKmh=elapsed?segmentDistance/(elapsed/3600000):0;
    $('trackViewMean').textContent='MEDIA TRAMO: '+Math.round(activeTrackRun.currentSegmentAverageKmh)+' KM/H';
    $('trackViewProgress').textContent=Math.round(clamp(sample.routeProgressKm/(getRouteDistanceKm(route)||1),0,1)*100)+'%';
    const x=445+1048*clamp(activeTrackRun.progressKm/(getRouteDistanceKm(route)||1),0,1);
    $('trackProgressFill').setAttribute('d','M445 722H'+x);
    $('trackProgressPointer').setAttribute('d','M'+x+' 702 '+(x-10)+' 688 '+(x+10)+' 688Z');
    updateTrackViewClock();
  }
  function evaluateActiveTrack(position,timestamp,previousPosition) {
    const track=getActiveTrack(),route=getActiveRoute();
    if (!track || route.length<2) return;
    const run=activeTrackRun;
    const startDistanceM=distanceFromTrackMarkKm(route[0],position)*1000;
    const finishDistanceM=distanceFromTrackMarkKm(route[route.length-1],position)*1000;
    if (startDistanceM>checkpointRadius+10) trackStartNearby=false;
    if (!run && previousPosition && !trackStartNearby && passedTrackMark(route[0],previousPosition,position) && speed>=movingThreshold) {
      const motionLat=position.latitude-previousPosition.latitude;
      const motionLon=(position.longitude-previousPosition.longitude)*Math.cos(radians(position.latitude));
      const targetLat=route[1].latitude-route[0].latitude;
      const targetLon=(route[1].longitude-route[0].longitude)*Math.cos(radians(route[0].latitude));
      if (motionLat*targetLat+motionLon*targetLon>0) startTrackRun(timestamp,false,position);
    }
    if (!activeTrackRun || activeTrackRun.trackId!==track.id) return;
    const active=activeTrackRun;
    appendTrackTelemetry(position,timestamp);
    const expected=active.nextCheckpoint;
    if (expected<route.length-1) {
      const mark=route[expected];
      if (passedTrackMark(mark,previousPosition,position)) {
        const elapsed=Math.max(0,timestamp-active.lastCheckpointAt);
        const travelled=Math.max(0,active.distanceKm-active.lastCheckpointDistanceKm);
        const average=elapsed>0?travelled/(elapsed/3600000):0;
        active.checkpointSplits.push({markIndex:active.reverse?track.marks.length-1-expected:expected,
          type:mark.type,timestamp,elapsedMs:Math.max(0,timestamp-active.startedAt),
          segmentTimeMs:elapsed,segmentDistanceKm:travelled,averageSpeedKmh:average,
          speedKmh:position.speed == null ? speed : Number(position.speed),
          latitude:position.latitude,longitude:position.longitude,accuracy:position.accuracy});
        active.currentSegmentAverageKmh=average;
        active.nextCheckpoint++;
        active.lastCheckpointAt=timestamp;
        active.lastCheckpointDistanceKm=active.distanceKm;
        renderTrackTimeStatus();
      }
    }
    const checkpointsDone=active.nextCheckpoint>=route.length-1;
    if (finishDistanceM>checkpointRadius+10) active.finishArmed=true;
    if (checkpointsDone && active.finishArmed && passedTrackMark(route[route.length-1],previousPosition,position) && !trackFinishNearby) {
      trackFinishNearby=true; completeTrackLap(track,timestamp,position);
    }
  }
  function completeTrackLap(track,timestamp,position) {
    const run=activeTrackRun;
    if (!run || run.trackId!==track.id) return;
    appendTrackTelemetry(position,timestamp);
    const lapTimeMs=Math.max(0,timestamp-run.startedAt);
    const traveled=Math.max(0,run.distanceKm);
    const finishElapsed=Math.max(0,timestamp-run.lastCheckpointAt);
    const finishDistance=Math.max(0,run.distanceKm-run.lastCheckpointDistanceKm);
    run.checkpointSplits.push({markIndex:run.reverse?0:track.marks.length-1,type:'FINISH',timestamp,
      elapsedMs:lapTimeMs,segmentTimeMs:finishElapsed,segmentDistanceKm:finishDistance,
      averageSpeedKmh:finishElapsed?finishDistance/(finishElapsed/3600000):0,
      speedKmh:position.speed == null ? speed : Number(position.speed),
      latitude:position.latitude,longitude:position.longitude,accuracy:position.accuracy});
    const result={id:'result-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),
      startedAt:run.startedAt,endedAt:timestamp,lapTimeMs,routeDistanceKm:traveled,completed:true,
      maxSpeed:run.maxSpeed,averageSpeed:lapTimeMs?traveled/(lapTimeMs/3600000):0,
      telemetry:run.samples,checkpointSplits:run.checkpointSplits,reverse:run.reverse};
    track.results=[...(track.results||[]),result];
    lastTrackTimeMs=lapTimeMs; activeTrackRun=null; trackStartNearby=false; trackFinishNearby=false;
    clearInterval(trackClockTimer); trackClockTimer=null;
    countdownRunning=false; setDisabled('countdownButton',false);
    saveTracks(); renderTrackTimeStatus(); updateLapView();
  }

  function renderHistory() {}

  function updateSettingsView() {
    $('limitReadout').textContent = String(limit);
    const limitToggle = $('limitToggle');
    limitToggle.classList.toggle('is-on',limitEnabled);
    limitToggle.setAttribute('aria-pressed',String(limitEnabled));
    limitToggle.setAttribute('aria-label',limitEnabled ? 'Desactivar límite de velocidad' : 'Activar límite de velocidad');
    limitToggle.querySelector('path').setAttribute('fill',limitEnabled ? 'url(#blueButton)' : 'url(#darkButton)');
    limitToggle.querySelector('path').setAttribute('stroke',limitEnabled ? '#08baff' : '#17639b');
    $('limitToggleLabel').textContent = limitEnabled ? 'LIM ON' : 'LIM OFF';
    $('autoStartValue').textContent = 'EN START';
    $('autoStartThreshold').textContent = 'COUNTDOWN';
    $('autoCheckpointValue').textContent = 'SIEMPRE ACTIVOS';
    $('checkpointRadius').textContent = checkpointRadius + ' M';
    const selectedTrack = getActiveTrack();
    $('finishCheckpointValue').textContent = selectedTrack
      ? selectedTrack.name + (activeTrackReverse ? ' · FINISH → START' : ' · START → FINISH')
      : 'NO TRACK SELECCIONADO';
    $('finishCheckpointValue').setAttribute('textLength','560');
    $('finishCheckpointValue').setAttribute('lengthAdjust','spacingAndGlyphs');
    const cpTrack = $('autoCheckpointToggle').querySelector('.toggle-track');
    const cpKnob = $('autoCheckpointToggle').querySelector('.toggle-knob');
    cpTrack.classList.add('is-on'); cpTrack.setAttribute('fill','#078aff'); cpKnob.setAttribute('cx','1399');
  }
  function saveSettings() {
    writeStored('gpsDriveLimit',String(limit));
    writeStored('gpsDriveLimitEnabled',String(limitEnabled));
    writeStored('gpsDriveCheckpointRadius',String(checkpointRadius));
    updateSettingsView(); updateLimitIndicator();
  }
  bindButton('limitMinus',() => { limit = clamp(limit - 5,1,300); saveSettings(); });
  bindButton('limitPlus',() => { limit = clamp(limit + 5,1,300); saveSettings(); });
  bindButton('limitToggle',() => { limitEnabled = !limitEnabled; saveSettings(); });
  bindButton('radiusMinus',() => { checkpointRadius = clamp(checkpointRadius - 5,5,100); saveSettings(); });
  bindButton('radiusPlus',() => { checkpointRadius = clamp(checkpointRadius + 5,5,100); saveSettings(); });

  let keyboardTarget = null;
  let keyboardType = 'numeric';
  let keyboardDraft = '';
  let keyboardReplaceNext = true;
  let keyboardValidator = null;
  let keyboardCommitter = null;

  function updateKeyboardPreview() {
    $('keyboardPreview').textContent = keyboardDraft || '-';
  }
  function closeConfigurationKeyboard() {
    const target = keyboardTarget;
    $('configKeyboard').style.display = 'none';
    $('configKeyboard').setAttribute('aria-hidden','true');
    $('keyboardMessage').textContent = '';
    if (target) {
      target.setAttribute('aria-expanded','false');
      if (typeof target.focus === 'function') target.focus();
    }
    keyboardTarget = null; keyboardValidator = null; keyboardCommitter = null;
  }
  function addKeyboardKey(id,label,value,x,y,width,height,kind = '',ariaLabel = label) {
    const key = makeSvg('g');
    key.setAttribute('id',id); key.setAttribute('class','keyboard-key interactive' + (kind ? ' is-' + kind : ''));
    key.setAttribute('role','button'); key.setAttribute('tabindex','0'); key.setAttribute('aria-label',ariaLabel);
    const rect = makeSvg('rect');
    rect.setAttribute('x',x); rect.setAttribute('y',y); rect.setAttribute('width',width); rect.setAttribute('height',height); rect.setAttribute('rx','7');
    const text = textNode(x + width / 2,y + height / 2 + (height > 58 ? 11 : 8),label,'keyboard-key-label','middle');
    key.append(rect,text); $('keyboardKeys').append(key);
    bindButton(id,() => {
      if (value === 'CANCEL') { closeConfigurationKeyboard(); return; }
      if (value === 'CONFIRM') { confirmConfigurationKeyboard(); return; }
      if (value === 'BACKSPACE') { eraseKeyboardCharacter(); return; }
      appendKeyboardCharacter(value);
    });
  }
  function drawConfigurationKeyboard() {
    const keys = $('keyboardKeys'); keys.replaceChildren();
    const panel = $('keyboardPanel');
    const divider = $('keyboardDivider');
    if (keyboardType === 'numeric') {
      panel.setAttribute('d','M640 135 665 110H935L960 135V665L935 690H665L640 665Z');
      divider.setAttribute('d','M666 184H934');
      for (let value = 1; value <= 9; value++) {
        const row = Math.floor((value - 1) / 3), column = (value - 1) % 3;
        addKeyboardKey('keyboard-digit-' + value,String(value),String(value),653 + column * 102,245 + row * 98,90,90);
      }
      addKeyboardKey('keyboard-cancel','X','CANCEL',650,548,90,90,'cancel','Cancelar y descartar cambios');
      addKeyboardKey('keyboard-digit-0','0','0',750,548,100,90);
      addKeyboardKey('keyboard-confirm','✓','CONFIRM',860,548,90,90,'confirm','Validar y guardar');
    } else {
      panel.setAttribute('d','M245 135 270 110H1330L1355 135V665L1330 690H270L245 665Z');
      divider.setAttribute('d','M292 184H1308');
      const rows = [
        ['Q','W','E','R','T','Y','U','I','O','P'],
        ['A','S','D','F','G','H','J','K','L'],
        ['Z','X','C','V','B','N','M','⌫']
      ];
      rows.forEach((row,rowIndex) => {
        const width = 66, gap = 8, height = 64, total = row.length * width + (row.length - 1) * gap;
        const startX = 686 - total / 2;
        row.forEach((value,column) => {
          const backspace = value === '⌫';
          const keyValue = backspace ? 'BACKSPACE' : value;
          addKeyboardKey('keyboard-alpha-' + rowIndex + '-' + column,backspace ? 'Borrar carácter' : value,keyValue,
            startX + column * (width + gap),255 + rowIndex * 72,width,height,backspace ? 'cancel' : '');
        });
      });
      const numbers = ['1','2','3','4','5','6','7','8','9'];
      numbers.forEach((value,index) => {
        const row = Math.floor(index / 3), column = index % 3;
        addKeyboardKey('keyboard-alpha-number-' + value,value,value,1080 + column * 72,270 + row * 72,64,64);
      });
      addKeyboardKey('keyboard-alpha-number-0','0','0',1152,486,80,64);
      addKeyboardKey('keyboard-cancel','X','CANCEL',638,560,82,72,'cancel','Cancelar y descartar cambios');
      addKeyboardKey('keyboard-space','ESPACIO','SPACE',730,560,140,72,'space');
      addKeyboardKey('keyboard-confirm','✓','CONFIRM',880,560,82,72,'confirm','Validar y guardar');
    }
    $('keyboardTitle').textContent = keyboardTarget.getAttribute('data-keyboard-label') || 'CONFIGURAR VALOR';
    updateKeyboardPreview();
    $('keyboardMessage').textContent = '';
  }
  function openConfigurationKeyboard(field,options = {}) {
    keyboardTarget = field;
    keyboardType = field.getAttribute('data-keyboard-type') === 'numeric' ? 'numeric' : 'alphanumeric';
    keyboardDraft = String(options.value ?? field.textContent ?? '').trim();
    keyboardReplaceNext = true;
    keyboardValidator = options.validate || (value => keyboardType === 'numeric' && !/^\d{1,3}$/.test(value)
      ? 'INTRODUCE UN VALOR NUMÉRICO' : '');
    keyboardCommitter = options.commit || (value => { field.textContent = value; });
    field.setAttribute('aria-expanded','true'); field.setAttribute('aria-controls','configKeyboard');
    $('configKeyboard').style.display = 'inline';
    $('configKeyboard').setAttribute('aria-hidden','false');
    drawConfigurationKeyboard();
    const firstKey = $('keyboardKeys').querySelector('.keyboard-key');
    if (firstKey && typeof firstKey.focus === 'function') firstKey.focus();
  }
  function appendKeyboardCharacter(character) {
    if (keyboardReplaceNext) { keyboardDraft = ''; keyboardReplaceNext = false; }
    if (keyboardType === 'numeric' && !/^\d$/.test(character)) return;
    const next = character === 'SPACE' ? ' ' : character;
    const maxLength = keyboardType === 'numeric' ? 3 : 32;
    if (keyboardDraft.length >= maxLength) return;
    keyboardDraft += next;
    updateKeyboardPreview(); $('keyboardMessage').textContent = '';
  }
  function eraseKeyboardCharacter() {
    if (keyboardReplaceNext) { keyboardDraft = ''; keyboardReplaceNext = false; }
    else keyboardDraft = Array.from(keyboardDraft).slice(0,-1).join('');
    updateKeyboardPreview(); $('keyboardMessage').textContent = '';
  }
  function confirmConfigurationKeyboard() {
    const error = keyboardValidator ? keyboardValidator(keyboardDraft) : '';
    if (error) { $('keyboardMessage').textContent = error; return; }
    const target = keyboardTarget, commit = keyboardCommitter, value = keyboardDraft;
    if (commit) commit(value,target);
    closeConfigurationKeyboard();
  }
  $('configKeyboard').addEventListener('keydown',event => {
    if (event.key === 'Escape') { event.preventDefault(); closeConfigurationKeyboard(); }
  });
  bindButton('limitReadout',() => openConfigurationKeyboard($('limitReadout'),{
    value:String(limit),
    validate:value => {
      if (!/^\d{1,3}$/.test(value)) return 'INTRODUCE UN VALOR ENTRE 1 Y 300';
      const numericValue = Number(value);
      return numericValue < 1 || numericValue > 300 ? 'EL LÍMITE DEBE SER DE 1 A 300 KM/H' : '';
    },
    commit:value => { limit = Number(value); saveSettings(); }
  }));

  function normalizeTracks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(track => track && typeof track === 'object')
      .map((track,index) => ({
        ...track,
        id:track.id || 'track-restored-' + index,
        number:track.number ?? index + 1,
        name:track.name || 'TRACK #' + (track.number || index + 1),
        marks:Array.isArray(track.marks) ? track.marks : [],
        results:Array.isArray(track.results) ? track.results : []
      }));
  }
  try {
    const storedTrackData=JSON.parse(readStored('gpsDriveTracks','[]'));
    if (!Array.isArray(storedTrackData)) throw new Error('Invalid track database');
    tracks=normalizeTracks(storedTrackData);
  } catch (_) { tracks = []; tracksStorageWritable=false; }
  nextTrackNumber = Math.max(nextTrackNumber,...tracks.map(track => track.number + 1),1);
  if (!tracks.some(track => track.id === activeTrackId)) activeTrackId = '';
  selectedLapPickerId = activeTrackId;
  if (resultsFilterId !== 'best' && !tracks.some(track => track.id === resultsFilterId)) resultsFilterId = 'best';
  try {
    const storedHistory = JSON.parse(readStored('gpsDriveSessions','[]'));
    if (!Array.isArray(storedHistory)) throw new Error('Invalid session history');
    sessionHistory = storedHistory;
  } catch (_) { sessionHistory = []; sessionsStorageWritable=false; }
  try {
    const storedLaps = JSON.parse(readStored('gpsDriveLaps','[]'));
    lapEntries = Array.isArray(storedLaps) ? storedLaps : [];
  } catch (_) { lapEntries = []; }
  try {
    const storedManualLaps=JSON.parse(readStored('gpsDriveManualLaps','[]'));
    manualLapRecords=Array.isArray(storedManualLaps)?storedManualLaps:[];
  } catch (_) { manualLapRecords=[]; }

  buildGauge();
  setupTrackScrollers();
  setupTrackTimeScroller();
  setupDropdownInteractions();
  updateSettingsView();
  renderLaps(); renderTrackDraft(); renderTrackList(); renderTrackResults(); renderTrackPickers(); renderHistory();
  updateSourceIndicator(null);
  updateSpeedDisplay(0,null,null);
  updateLapStatus();
  updateLapView(); showLapPanel(true);
  setDisabled('stopGPS',true); setDisabled('lapStop',true);
  showPage('drive');
  if ('serviceWorker' in navigator && typeof location !== 'undefined' && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(() => {});
  }
})();
