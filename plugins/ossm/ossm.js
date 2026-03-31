(function initOssmPlugin() {
  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.React) {
    return;
  }

  var React = PluginApi.React;
  var h = React.createElement;
  var Bootstrap = PluginApi.libraries.Bootstrap || {};
  var BootstrapNav = Bootstrap.Nav;
  var BootstrapTab = Bootstrap.Tab;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useState = React.useState;
  var useSyncExternalStore = React.useSyncExternalStore;
  var useInteractive = PluginApi.hooks && typeof PluginApi.hooks.useInteractive === 'function'
    ? PluginApi.hooks.useInteractive
    : null;

  var SERVICE_UUID = '522b443a-4f53-534d-0001-420badbabe69';
  var COMMAND_CHARACTERISTIC_UUID = '522b443a-4f53-534d-1000-420badbabe69';
  var SPEED_KNOB_CHARACTERISTIC_UUID = '522b443a-4f53-534d-1010-420badbabe69';
  var LATENCY_CHARACTERISTIC_UUID = '522b443a-4f53-534d-1030-420badbabe69';
  var STATE_CHARACTERISTIC_UUID = '522b443a-4f53-534d-2000-420badbabe69';
  var STORAGE_KEY = 'plugin.ossm.settings';
  var DEVICE_STORAGE_KEY = 'plugin.ossm.deviceId';
  var LOG_LIMIT = 200;
  var TICK_INTERVAL_MS = 5;
  var encoder = new window.TextEncoder();
  var decoder = new window.TextDecoder();

  var DEFAULT_SETTINGS = {
    fineOffsetMs: 0,
    bufferMs: 0,
    outputMin: 0,
    strokeLength: 100,
    simpleMode: true,
    reverse: false,
    latencyCompensation: true,
    speed: 100,
    stroke: 50,
    depth: 50,
    sensation: 50,
  };

  function readSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return normalizeSettings(DEFAULT_SETTINGS);
      }

      var parsed = JSON.parse(raw);
      return normalizeSettings(parsed || {});
    } catch (error) {
      return normalizeSettings(DEFAULT_SETTINGS);
    }
  }

  function writeSettings(settings) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
    } catch (error) {
      // Ignore localStorage failures.
    }
  }

  function readStoredDeviceId() {
    try {
      return String(window.localStorage.getItem(DEVICE_STORAGE_KEY) || '');
    } catch (error) {
      return '';
    }
  }

  function writeStoredDeviceId(deviceId) {
    try {
      if (!deviceId) {
        window.localStorage.removeItem(DEVICE_STORAGE_KEY);
        return;
      }

      window.localStorage.setItem(DEVICE_STORAGE_KEY, String(deviceId));
    } catch (error) {
      // Ignore localStorage failures.
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeSettings(input) {
    var source = input && typeof input === 'object' ? input : {};
    var normalized = Object.assign({}, DEFAULT_SETTINGS, source);
    var outputMin = clamp(toInteger(normalized.outputMin, DEFAULT_SETTINGS.outputMin), 0, 100);
    var strokeLengthSource = Object.prototype.hasOwnProperty.call(source, 'strokeLength')
      ? source.strokeLength
      : Object.prototype.hasOwnProperty.call(source, 'outputMax')
        ? toInteger(source.outputMax, 100) - outputMin
        : DEFAULT_SETTINGS.strokeLength;
    var strokeLength = clamp(toInteger(strokeLengthSource, DEFAULT_SETTINGS.strokeLength), 0, 100 - outputMin);

    normalized.outputMin = outputMin;
    normalized.strokeLength = strokeLength;
    delete normalized.outputMax;

    return normalized;
  }

  function toInteger(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  }

  function isOssmConnectionKey(value) {
    return String(value || '') == 'ossm';
  }

  function decodeCharacteristicValue(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    if (value instanceof DataView) {
      return decoder.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }

    if (value.buffer instanceof ArrayBuffer) {
      return decoder.decode(value.buffer);
    }

    return String(value);
  }

  function resolvePath(path) {
    return new window.URL(path, window.location.origin).toString();
  }

  function shortFileName(path) {
    if (!path) {
      return 'No script loaded';
    }

    var clean = String(path).split('?')[0];
    var parts = clean.split('/');
    return parts[parts.length - 1] || clean;
  }

  function parseCsvScript(content) {
    return String(content || '')
      .split(/\r?\n/)
      .map(function parseLine(line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed.indexOf(',') === -1) {
          return null;
        }

        var parts = trimmed.split(',');
        var at = Number(parts[0]);
        var pos = Number(parts[1]);
        if (!Number.isFinite(at) || !Number.isFinite(pos)) {
          return null;
        }

        return {
          at: Math.max(0, Math.round(at)),
          pos: clamp(Math.round(pos), 0, 100),
        };
      })
      .filter(Boolean);
  }

  function buildSimpleActions(actions) {
    if (actions.length <= 2) {
      return actions.slice();
    }

    var simple = [actions[0]];
    var lastDirection = 0;
    for (var index = 0; index < actions.length - 1; index += 1) {
      var current = actions[index];
      var next = actions[index + 1];
      var delta = next.pos - current.pos;

      if (delta === 0) {
        continue;
      }

      var direction = delta > 0 ? 1 : -1;
      if (lastDirection !== 0 && direction !== lastDirection) {
        simple.push(current);
      }
      lastDirection = direction;
    }

    simple.push(actions[actions.length - 1]);
    return simple;
  }

  function parseFunscript(content) {
    var parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      parsed = null;
    }

    var actions = [];
    if (parsed && Array.isArray(parsed.actions)) {
      actions = parsed.actions
        .map(function mapAction(action) {
          return {
            at: Math.max(0, Math.round(Number(action.at))),
            pos: clamp(Math.round(Number(action.pos)), 0, 100),
          };
        })
        .filter(function keepFinite(action) {
          return Number.isFinite(action.at) && Number.isFinite(action.pos);
        });
    }

    if (actions.length === 0) {
      actions = parseCsvScript(content);
    }

    actions.sort(function sortActions(left, right) {
      return left.at - right.at;
    });

    if (actions.length < 2) {
      throw new Error('Funscript must contain at least two actions');
    }

    return {
      actions: actions,
      simpleActions: buildSimpleActions(actions),
      metadata: parsed && typeof parsed === 'object' ? parsed : {},
    };
  }

  function getCurrentActionCount(snapshot) {
    if (!snapshot) {
      return 0;
    }

    if (snapshot.settings && snapshot.settings.simpleMode) {
      return snapshot.simpleActionCount || 0;
    }

    return snapshot.actionCount || 0;
  }

  function createRuntimeStore() {
    var listeners = new Set();
    var device = null;
    var server = null;
    var commandCharacteristic = null;
    var speedKnobCharacteristic = null;
    var latencyCharacteristic = null;
    var stateCharacteristic = null;
    var stateListener = null;
    var syncInterval = null;
    var idlePreviewTimer = null;
    var pendingIdlePreviewPosition = null;
    var idlePreviewInFlight = false;
    var currentActionIndex = 0;
    var lastSentActionAt = -1;
    var lastObservedEffectiveTime = 0;
    var gattOperationQueue = Promise.resolve();

    var state = {
      supported: typeof navigator !== 'undefined' && !!navigator.bluetooth,
      connectionStatus: 'disconnected',
      deviceName: '',
      error: null,
      logs: [],
      settings: readSettings(),
      connectionKey: '',
      scriptOffsetMs: 0,
      currentScriptPath: '',
      actionCount: 0,
      simpleActionCount: 0,
      commandsSent: 0,
      currentPosition: 0,
      currentTimeMs: 0,
      isPlaying: false,
      looping: false,
      deviceState: null,
      streamingReady: false,
    };

    function emit() {
      listeners.forEach(function notify(listener) {
        listener();
      });
    }

    function setState(patch) {
      state = Object.assign({}, state, patch);
      emit();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    }

    function getSnapshot() {
      return state;
    }

    function addLog(direction, message) {
      var nextLog = {
        id: String(Date.now()) + ':' + String(Math.random()),
        direction: direction,
        message: String(message),
        timestamp: new Date().toISOString().split('T')[1].slice(0, 12),
      };

      setState({
        logs: state.logs.concat(nextLog).slice(-LOG_LIMIT),
      });
    }

    function clearError() {
      if (state.error) {
        setState({ error: null });
      }
    }

    function setError(message) {
      setState({ error: String(message || 'Unknown OSSM error') });
    }

    function enqueueGattOperation(operation) {
      var queuedOperation = gattOperationQueue.catch(function ignoreQueueError() {
        return null;
      }).then(function runQueuedOperation() {
        return operation();
      });

      gattOperationQueue = queuedOperation.catch(function keepQueueAlive() {
        return null;
      });

      return queuedOperation;
    }

    function getCharacteristicWriter(characteristic) {
      if (!characteristic) {
        return null;
      }

      if (typeof characteristic.writeValueWithResponse === 'function') {
        return characteristic.writeValueWithResponse.bind(characteristic);
      }

      if (typeof characteristic.writeValue === 'function') {
        return characteristic.writeValue.bind(characteristic);
      }

      if (typeof characteristic.writeValueWithoutResponse === 'function') {
        return characteristic.writeValueWithoutResponse.bind(characteristic);
      }

      return null;
    }

    function getActiveActions() {
      var source = state.settings.simpleMode ? state.simpleActions : state.actions;
      return Array.isArray(source) ? source : [];
    }

    function getPlayerTimeMs() {
      var player = PluginApi.utils.InteractiveUtils.getPlayer ? PluginApi.utils.InteractiveUtils.getPlayer() : null;
      if (!player || typeof player.currentTime !== 'function') {
        return null;
      }

      var currentTime = Number(player.currentTime());
      return Number.isFinite(currentTime) ? currentTime * 1000 : null;
    }

    function getOutputRange() {
      var rawMin = clamp(toInteger(state.settings.outputMin, 0), 0, 100);
      var strokeLength = clamp(toInteger(state.settings.strokeLength, 100), 0, 100 - rawMin);
      return {
        min: rawMin,
        max: rawMin + strokeLength,
      };
    }

    function mapOutputPosition(position) {
      var range = getOutputRange();
      var normalized = clamp(Number(position), 0, 100) / 100;
      return Math.round(range.min + normalized * (range.max - range.min));
    }

    function getStreamTargetPosition(position) {
      var mappedPosition = mapOutputPosition(position);
      if (!state.settings.reverse) {
        return mappedPosition;
      }

      return clamp(100 - mappedPosition, 0, 100);
    }

    function getIdlePreviewTargetPosition() {
      var range = getOutputRange();
      if (!state.settings.reverse) {
        return range.max;
      }

      return clamp(100 - range.max, 0, 100);
    }

    function getEffectivePlaybackTime(playbackMs) {
      return playbackMs + state.scriptOffsetMs + state.settings.fineOffsetMs + state.settings.bufferMs;
    }

    function resetPlayback(playbackMs) {
      var actions = getActiveActions();
      var effectivePlaybackMs = getEffectivePlaybackTime(playbackMs || 0);
      currentActionIndex = 0;
      while (currentActionIndex < actions.length && actions[currentActionIndex].at <= effectivePlaybackMs) {
        currentActionIndex += 1;
      }

      lastSentActionAt = effectivePlaybackMs - 1;
      lastObservedEffectiveTime = effectivePlaybackMs;
      setState({
        commandsSent: 0,
        currentTimeMs: playbackMs || 0,
      });
    }

    function writeBooleanCharacteristic(characteristic, value) {
      if (!characteristic) {
        return Promise.resolve();
      }

      var writer = getCharacteristicWriter(characteristic);
      if (!writer) {
        return Promise.reject(new Error('Characteristic does not support writes'));
      }

      return enqueueGattOperation(function writeBooleanValue() {
        return writer(encoder.encode(value ? 'true' : 'false'));
      });
    }

    function sendCommand(command) {
      if (!commandCharacteristic) {
        return Promise.resolve(false);
      }

      var payload = encoder.encode(command);
      var writer = getCharacteristicWriter(commandCharacteristic);
      if (!writer) {
        return Promise.reject(new Error('Command characteristic does not support writes'));
      }

      return enqueueGattOperation(function writeCommand() {
        return writer(payload);
      })
        .then(function onWrite() {
          addLog('TX', command);
          return true;
        })
        .catch(function onError(error) {
          addLog('ERR', 'Command failed: ' + (error && error.message ? error.message : error));
          setError(error && error.message ? error.message : error);
          return false;
        });
    }

    function sendStreamPosition(position, timeMs) {
      var clampedPosition = clamp(Math.round(position), 0, 100);
      var clampedTime = clamp(Math.round(timeMs), 0, 10000);
      return sendCommand('stream:' + clampedPosition + ':' + clampedTime).then(function onSent(success) {
        if (!success) {
          return false;
        }

        setState({
          commandsSent: state.commandsSent + 1,
          currentPosition: clampedPosition,
        });
        return true;
      });
    }

    function applyDeviceState(deviceState) {
      if (!deviceState || typeof deviceState !== 'object') {
        return;
      }

      var nextSettings = {};
      if (Number.isFinite(deviceState.speed)) {
        nextSettings.speed = clamp(Math.round(deviceState.speed), 0, 100);
      }
      if (Number.isFinite(deviceState.stroke)) {
        nextSettings.stroke = clamp(Math.round(deviceState.stroke), 0, 100);
      }
      if (Number.isFinite(deviceState.depth)) {
        nextSettings.depth = clamp(Math.round(deviceState.depth), 0, 100);
      }
      if (Number.isFinite(deviceState.sensation)) {
        nextSettings.sensation = clamp(Math.round(deviceState.sensation), 0, 100);
      }
      if (Number.isFinite(deviceState.buffer)) {
        nextSettings.bufferMs = clamp(Math.round(Number(deviceState.buffer) * 2), 0, 1000);
      }

      var desiredSettings = state.settings;
      var wasStreamingReady = state.streamingReady;
      var mergedSettings = normalizeSettings(Object.assign({}, state.settings, nextSettings));
      var deviceMode = String(deviceState.state || '');
      var streamingReady = deviceMode === 'streaming.idle' || deviceMode === 'streaming';
      writeSettings(mergedSettings);
      setState({
        deviceState: deviceState,
        settings: mergedSettings,
        streamingReady: streamingReady,
      });

      if (streamingReady && !wasStreamingReady) {
        writeBooleanCharacteristic(speedKnobCharacteristic, false)
          .then(function syncStreamingSettingsAfterIdle() {
            return applyLiveSettings({
              latencyCompensation: desiredSettings.latencyCompensation,
              bufferMs: desiredSettings.bufferMs,
              speed: clamp(Math.round(desiredSettings.speed || 100), 1, 100),
              sensation: clamp(Math.round(desiredSettings.sensation || 50), 1, 100),
            });
          })
          .catch(function onStreamingSettingsSyncError(error) {
            setError(error && error.message ? error.message : error);
            addLog('ERR', 'Streaming settings sync failed: ' + (error && error.message ? error.message : error));
          });
      }
    }

    function handleStateCharacteristic(value) {
      var text = decodeCharacteristicValue(value);
      addLog('RX', 'state: ' + text);

      var trimmedText = String(text || '').trim();
      if (!trimmedText || (trimmedText.charAt(0) !== '{' && trimmedText.charAt(0) !== '[')) {
        return;
      }

      try {
        applyDeviceState(JSON.parse(trimmedText));
      } catch (error) {
        addLog('ERR', 'State parse failed: ' + error.message);
      }
    }

    function applyLiveSettings(changes) {
      var operations = [];

      if (Object.prototype.hasOwnProperty.call(changes, 'latencyCompensation')) {
        operations.push(function syncLatencyCompensation() {
          return writeBooleanCharacteristic(latencyCharacteristic, changes.latencyCompensation);
        });
      }

      if (Object.prototype.hasOwnProperty.call(changes, 'bufferMs')) {
        operations.push(function syncBuffer() {
          return sendCommand('set:buffer:' + clamp(Math.round(changes.bufferMs / 2), 0, 500));
        });
      }

      ['speed', 'stroke', 'depth', 'sensation'].forEach(function syncKey(key) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          operations.push(function syncSetting() {
            return sendCommand('set:' + key + ':' + clamp(Math.round(changes[key]), 0, 100));
          });
        }
      });

      return operations.reduce(function runSequentially(chain, operation) {
        return chain.then(operation);
      }, Promise.resolve());
    }

    function updateSettings(changes, syncToDevice) {
      var previousSettings = state.settings;
      var nextSettings = normalizeSettings(Object.assign({}, state.settings, changes || {}));
      writeSettings(nextSettings);
      setState({ settings: nextSettings });

      if (
        changes &&
        Object.prototype.hasOwnProperty.call(changes, 'outputMin') &&
        nextSettings.outputMin !== previousSettings.outputMin
      ) {
        queueIdlePreviewPosition(getIdlePreviewTargetPosition());
      }

      if (syncToDevice && state.connectionStatus === 'connected') {
        return applyLiveSettings(changes || {}).catch(function onSyncError(error) {
          setError(error && error.message ? error.message : error);
        });
      }

      return Promise.resolve();
    }

    function stopSync() {
      if (syncInterval) {
        window.clearInterval(syncInterval);
        syncInterval = null;
      }

      if (state.isPlaying) {
        setState({ isPlaying: false });
      }
    }

    function clearIdlePreviewTimer() {
      if (idlePreviewTimer) {
        window.clearTimeout(idlePreviewTimer);
        idlePreviewTimer = null;
      }
    }

    function cancelIdlePreview() {
      clearIdlePreviewTimer();
      pendingIdlePreviewPosition = null;
    }

    function canPreviewIdlePosition() {
      return Boolean(
        server &&
        server.connected &&
        state.connectionStatus === 'connected' &&
        state.streamingReady &&
        !state.isPlaying
      );
    }

    function flushIdlePreview() {
      if (idlePreviewInFlight || pendingIdlePreviewPosition == null) {
        return;
      }

      if (!canPreviewIdlePosition()) {
        pendingIdlePreviewPosition = null;
        return;
      }

      var targetPosition = clamp(toInteger(pendingIdlePreviewPosition, state.currentPosition || 0), 0, 100);
      var currentPosition = clamp(toInteger(state.currentPosition, targetPosition), 0, 100);
      var distance = Math.abs(targetPosition - currentPosition);
      var durationMs = clamp(Math.max(600, distance * 25), 600, 3000);

      pendingIdlePreviewPosition = null;
      idlePreviewInFlight = true;

      sendStreamPosition(targetPosition, durationMs)
        .catch(function ignoreIdlePreviewError() {
          return false;
        })
        .finally(function onIdlePreviewSettled() {
          idlePreviewInFlight = false;
          if (pendingIdlePreviewPosition != null) {
            flushIdlePreview();
          }
        });
    }

    function queueIdlePreviewPosition(position) {
      if (!canPreviewIdlePosition()) {
        return;
      }

      pendingIdlePreviewPosition = clamp(toInteger(position, 0), 0, 100);
      clearIdlePreviewTimer();
      idlePreviewTimer = window.setTimeout(function runIdlePreview() {
        idlePreviewTimer = null;
        flushIdlePreview();
      }, 75);
    }

    function disconnectInternal() {
      stopSync();
      cancelIdlePreview();
      gattOperationQueue = Promise.resolve();

      if (stateCharacteristic && stateListener) {
        try {
          stateCharacteristic.removeEventListener('characteristicvaluechanged', stateListener);
        } catch (error) {
          // Ignore listener cleanup failures.
        }
      }

      stateListener = null;
      stateCharacteristic = null;
      latencyCharacteristic = null;
      speedKnobCharacteristic = null;
      commandCharacteristic = null;
      server = null;
      device = null;

      setState({
        connectionStatus: 'disconnected',
        deviceName: '',
        streamingReady: false,
      });
      addLog('INFO', 'Device disconnected');
    }

    function onGattDisconnected() {
      disconnectInternal();
    }

    function connectToDevice(selectedDevice) {
      if (!selectedDevice) {
        return Promise.reject(new Error('No OSSM device selected'));
      }

      device = selectedDevice;
      try {
        device.removeEventListener('gattserverdisconnected', onGattDisconnected);
      } catch (error) {
        // Ignore listener cleanup failures.
      }
      device.addEventListener('gattserverdisconnected', onGattDisconnected);
      if (device.id) {
        writeStoredDeviceId(device.id);
      }
      setState({ deviceName: device.name || 'OSSM' });
      addLog('INFO', 'Selected device: ' + (device.name || 'OSSM'));

      return device.gatt.connect()
        .then(function onServerConnected(connectedServer) {
          server = connectedServer;
          addLog('INFO', 'Connected to GATT server');
          return server.getPrimaryService(SERVICE_UUID);
        })
        .then(function onService(service) {
          return Promise.all([
            service.getCharacteristic(COMMAND_CHARACTERISTIC_UUID),
            service.getCharacteristic(SPEED_KNOB_CHARACTERISTIC_UUID).catch(function ignore() {
              return null;
            }),
            service.getCharacteristic(LATENCY_CHARACTERISTIC_UUID).catch(function ignore() {
              return null;
            }),
            service.getCharacteristic(STATE_CHARACTERISTIC_UUID).catch(function ignore() {
              return null;
            }),
          ]);
        })
        .then(function onCharacteristics(characteristics) {
          commandCharacteristic = characteristics[0];
          speedKnobCharacteristic = characteristics[1];
          latencyCharacteristic = characteristics[2];
          stateCharacteristic = characteristics[3];

          addLog('INFO', 'BLE characteristics ready');

          var setup = Promise.resolve();
          if (stateCharacteristic) {
            stateListener = function onStateChange(event) {
              handleStateCharacteristic(event.target.value);
            };

            setup = setup.then(function readInitialState() {
              return enqueueGattOperation(function queueStateRead() {
                return stateCharacteristic.readValue();
              })
                .then(handleStateCharacteristic)
                .catch(function ignore() {
                  return null;
                });
            });

            setup = setup.then(function enableStateNotifications() {
              return enqueueGattOperation(function queueStartNotifications() {
                return stateCharacteristic.startNotifications();
              }).then(function subscribe() {
                stateCharacteristic.addEventListener('characteristicvaluechanged', stateListener);
              });
            });
          }

          return setup
            .then(function enterStreamingMode() {
              return sendCommand('go:streaming');
            })
            .then(function syncStreamingSettings() {
              return writeBooleanCharacteristic(speedKnobCharacteristic, false).then(function syncAfterDisableSpeedKnobLimit() {
                return applyLiveSettings({
                  latencyCompensation: state.settings.latencyCompensation,
                  bufferMs: state.settings.bufferMs,
                  speed: clamp(Math.round(state.settings.speed || 100), 1, 100),
                  sensation: clamp(Math.round(state.settings.sensation || 50), 1, 100),
                });
              });
            });
        })
        .then(function onReady() {
          setState({ connectionStatus: 'connected' });
          addLog('INFO', 'OSSM BLE session is ready; waiting for streaming.idle');
          return true;
        });
    }

    function reconnectKnownDevice() {
      if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') {
        return Promise.resolve(false);
      }

      var storedDeviceId = readStoredDeviceId();
      return navigator.bluetooth.getDevices().then(function onDevices(devices) {
        if (!Array.isArray(devices) || devices.length === 0) {
          return false;
        }

        var knownDevice = null;
        if (storedDeviceId) {
          knownDevice = devices.find(function findStoredDevice(candidate) {
            return candidate && candidate.id === storedDeviceId;
          }) || null;
        }

        if (!knownDevice) {
          knownDevice = devices.find(function findNamedDevice(candidate) {
            return candidate && candidate.name === 'OSSM';
          }) || devices[0] || null;
        }

        if (!knownDevice) {
          return false;
        }

        addLog('INFO', 'Reconnecting to previously granted device: ' + (knownDevice.name || 'OSSM'));
        return connectToDevice(knownDevice);
      }).catch(function onReconnectError(error) {
        addLog('ERR', 'Reconnect failed: ' + (error && error.message ? error.message : error));
        return false;
      });
    }

    function connect(options) {
      if (!state.supported) {
        var supportError = new Error('Web Bluetooth is not supported by this browser');
        setError(supportError.message);
        return Promise.reject(supportError);
      }

      var allowRequest = !options || options.allowRequest !== false;

      if (state.connectionStatus === 'connecting') {
        return Promise.resolve();
      }

      if (server && server.connected) {
        setState({ connectionStatus: 'connected' });
        return Promise.resolve();
      }

      clearError();
      setState({ connectionStatus: 'connecting', streamingReady: false });
      addLog('INFO', allowRequest ? 'Requesting OSSM device' : 'Trying previously granted OSSM device');

      return reconnectKnownDevice()
        .then(function onReconnectAttempt(reconnected) {
          if (reconnected || !allowRequest) {
            if (!reconnected && !allowRequest) {
              setState({ connectionStatus: 'disconnected' });
            }
            return reconnected;
          }

          return navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            optionalServices: [SERVICE_UUID],
          }).then(function onDeviceSelected(selectedDevice) {
            return connectToDevice(selectedDevice);
          });
        })
        .catch(function onConnectError(error) {
          setState({ connectionStatus: 'disconnected' });
          setError(error && error.message ? error.message : error);
          addLog('ERR', 'Connection failed: ' + (error && error.message ? error.message : error));
          throw error;
        });
    }

    function disconnect() {
      stopSync();

      return sendCommand('set:speed:0')
        .catch(function ignore() {
          return false;
        })
        .finally(function alwaysDisconnect() {
          if (server && server.connected) {
            server.disconnect();
          }
          disconnectInternal();
        });
    }

    function maybeResyncIndex(playbackMs) {
      if (playbackMs < lastObservedEffectiveTime - 250) {
        resetPlayback(playbackMs);
      }
    }

    function processPlayback(playbackMs) {
      var actions = getActiveActions();
      if (!server || !server.connected || actions.length < 2) {
        return Promise.resolve();
      }

      var effectivePlaybackMs = getEffectivePlaybackTime(playbackMs);
      maybeResyncIndex(playbackMs);
      lastObservedEffectiveTime = effectivePlaybackMs;
      setState({ currentTimeMs: playbackMs });

      var chain = Promise.resolve();
      while (currentActionIndex < actions.length - 1) {
        var currentAction = actions[currentActionIndex];
        if (currentAction.at > effectivePlaybackMs) {
          break;
        }

        var nextAction = actions[currentActionIndex + 1];
        if (currentAction.at > lastSentActionAt) {
          (function queueAction(action, upcomingAction) {
            var targetPosition = getStreamTargetPosition(upcomingAction.pos);
            var duration = Math.max(0, upcomingAction.at - action.at);
            chain = chain.then(function runAction() {
              return sendStreamPosition(targetPosition, duration);
            });
          })(currentAction, nextAction);
          lastSentActionAt = currentAction.at;
        }

        currentActionIndex += 1;
      }

      return chain;
    }

    function startSync(positionSeconds) {
      var playbackMs = Number(positionSeconds) * 1000;
      if (!Number.isFinite(playbackMs)) {
        playbackMs = getPlayerTimeMs() || 0;
      }

      cancelIdlePreview();
      resetPlayback(playbackMs);
      setState({ isPlaying: true });
      processPlayback(playbackMs);

      if (!syncInterval) {
        syncInterval = window.setInterval(function tick() {
          var currentPlaybackMs = getPlayerTimeMs();
          if (currentPlaybackMs == null) {
            return;
          }

          processPlayback(currentPlaybackMs).catch(function onTickError(error) {
            setError(error && error.message ? error.message : error);
            addLog('ERR', 'Sync failed: ' + (error && error.message ? error.message : error));
          });
        }, TICK_INTERVAL_MS);
      }
    }

    function loadScript(funscriptPath) {
      if (!funscriptPath) {
        return Promise.resolve();
      }

      if (funscriptPath === state.currentScriptPath) {
        return Promise.resolve();
      }

      clearError();
      addLog('INFO', 'Fetching funscript: ' + shortFileName(funscriptPath));

      return window
        .fetch(resolvePath(funscriptPath), {
          credentials: 'same-origin',
        })
        .then(function onResponse(response) {
          if (!response.ok) {
            throw new Error('Failed to fetch funscript: HTTP ' + response.status);
          }
          return response.text();
        })
        .then(function onText(content) {
          var parsed = parseFunscript(content);
          state.actions = parsed.actions;
          state.simpleActions = parsed.simpleActions;
          setState({
            currentScriptPath: funscriptPath,
            actionCount: parsed.actions.length,
            simpleActionCount: parsed.simpleActions.length,
          });
          resetPlayback(0);
          addLog('INFO', 'Loaded ' + parsed.actions.length + ' funscript actions');
        })
        .catch(function onScriptError(error) {
          setError(error && error.message ? error.message : error);
          addLog('ERR', 'Script load failed: ' + (error && error.message ? error.message : error));
          throw error;
        });
    }

    function configureInteractive(config) {
      var nextConnectionKey = Object.prototype.hasOwnProperty.call(config, 'connectionKey')
        ? String(config.connectionKey || '')
        : state.connectionKey;
      var nextScriptOffset = Object.prototype.hasOwnProperty.call(config, 'scriptOffset')
        ? toInteger(config.scriptOffset, state.scriptOffsetMs)
        : Object.prototype.hasOwnProperty.call(config, 'offset')
          ? toInteger(config.offset, state.scriptOffsetMs)
          : state.scriptOffsetMs;

      var wasOssm = isOssmConnectionKey(state.connectionKey);
      var willBeOssm = isOssmConnectionKey(nextConnectionKey);

      setState({
        connectionKey: nextConnectionKey,
        scriptOffsetMs: nextScriptOffset,
      });

      if (wasOssm && !willBeOssm && state.connectionStatus !== 'disconnected') {
        return disconnect();
      }

      return Promise.resolve();
    }

    function isEnabled() {
      return isOssmConnectionKey(state.connectionKey);
    }

    function play(positionSeconds) {
      if (!isEnabled()) {
        return Promise.resolve();
      }

      return connect({ allowRequest: false }).then(function onConnected() {
        if (!server || !server.connected || state.connectionStatus !== 'connected') {
          setError('Connect the OSSM from the plugin button before starting playback');
          addLog('ERR', 'Playback requested while OSSM is not connected');
          return;
        }

        if (!state.streamingReady) {
          var currentMode = state.deviceState && state.deviceState.state ? String(state.deviceState.state) : '';
          if (currentMode === 'streaming.preflight') {
            setError('OSSM is in streaming preflight. Turn the physical speed knob to 0 until it reaches streaming.idle.');
            addLog('ERR', 'Playback blocked: OSSM is waiting for the physical speed knob to reach 0');
            return;
          }

          setError('OSSM is still entering streaming mode. Wait for streaming.idle before playback.');
          addLog('ERR', 'Playback requested before OSSM reached streaming.idle');
          return;
        }

        startSync(positionSeconds);
      });
    }

    function pause() {
      stopSync();
      return Promise.resolve();
    }

    function stop() {
      stopSync();

      if (state.connectionStatus !== 'connected') {
        return Promise.resolve();
      }

      return sendCommand('set:speed:0').then(function onStop() {
        addLog('INFO', 'Stopped active OSSM playback');
      });
    }

    function ensurePlaying(positionSeconds) {
      if (!state.isPlaying) {
        return play(positionSeconds);
      }

      var currentPlaybackMs = Number(positionSeconds) * 1000;
      if (Number.isFinite(currentPlaybackMs)) {
        maybeResyncIndex(currentPlaybackMs);
        return processPlayback(currentPlaybackMs);
      }

      return Promise.resolve();
    }

    function setLooping(looping) {
      setState({ looping: Boolean(looping) });
      return Promise.resolve();
    }

    window.addEventListener('beforeunload', function onUnload() {
      stopSync();
    });

    return {
      subscribe: subscribe,
      getSnapshot: getSnapshot,
      connect: connect,
      disconnect: disconnect,
      configureInteractive: configureInteractive,
      loadScript: loadScript,
      play: play,
      pause: pause,
      stop: stop,
      ensurePlaying: ensurePlaying,
      setLooping: setLooping,
      updateSettings: updateSettings,
      clearLogs: function clearLogs() {
        setState({ logs: [] });
      },
      clearError: clearError,
      sync: function sync() {
        return Promise.resolve(1);
      },
      isEnabled: isEnabled,
    };
  }

  var runtime = createRuntimeStore();

  function OssmInteractiveClient(store) {
    this._store = store;
  }

  Object.defineProperties(OssmInteractiveClient.prototype, {
    handyKey: {
      get: function getHandyKey() {
        var snapshot = this._store.getSnapshot();
        return this._store.isEnabled() ? snapshot.connectionKey : '';
      },
      set: function setHandyKey(key) {
        this._store.configureInteractive({ connectionKey: key });
      },
    },
    connected: {
      get: function getConnected() {
        return this._store.getSnapshot().connectionStatus === 'connected';
      },
    },
    playing: {
      get: function getPlaying() {
        return this._store.getSnapshot().isPlaying;
      },
    },
  });

  OssmInteractiveClient.prototype.connect = function connect() {
    if (!this._store.isEnabled()) {
      return Promise.resolve();
    }
    return this._store.connect({ allowRequest: false });
  };

  OssmInteractiveClient.prototype.uploadScript = function uploadScript(funscriptPath) {
    if (!this._store.isEnabled()) {
      return Promise.resolve();
    }
    return this._store.loadScript(funscriptPath);
  };

  OssmInteractiveClient.prototype.sync = function sync() {
    return this._store.sync();
  };

  OssmInteractiveClient.prototype.configure = function configure(config) {
    return this._store.configureInteractive(config || {});
  };

  OssmInteractiveClient.prototype.play = function play(position) {
    return this._store.play(position);
  };

  OssmInteractiveClient.prototype.pause = function pause() {
    return this._store.pause();
  };

  OssmInteractiveClient.prototype.stop = function stop() {
    return this._store.stop();
  };

  OssmInteractiveClient.prototype.ensurePlaying = function ensurePlaying(position) {
    return this._store.ensurePlaying(position);
  };

  OssmInteractiveClient.prototype.setLooping = function setLooping(looping) {
    return this._store.setLooping(looping);
  };

  function HybridInteractiveClient(ossmClient, fallbackClient) {
    this._ossmClient = ossmClient;
    this._fallbackClient = fallbackClient;
  }

  HybridInteractiveClient.prototype._active = function active() {
    return this._ossmClient.handyKey ? this._ossmClient : this._fallbackClient || this._ossmClient;
  };

  Object.defineProperties(HybridInteractiveClient.prototype, {
    handyKey: {
      get: function getHandyKey() {
        var client = this._active();
        return client && typeof client.handyKey !== 'undefined' ? client.handyKey : '';
      },
      set: function setHandyKey(key) {
        if (this._fallbackClient && typeof this._fallbackClient.handyKey !== 'undefined') {
          this._fallbackClient.handyKey = key;
        }
        this._ossmClient.handyKey = key;
      },
    },
    connected: {
      get: function getConnected() {
        return Boolean(this._active() && this._active().connected);
      },
    },
    playing: {
      get: function getPlaying() {
        return Boolean(this._active() && this._active().playing);
      },
    },
  });

  HybridInteractiveClient.prototype.connect = function connect() {
    return this._active().connect();
  };

  HybridInteractiveClient.prototype.uploadScript = function uploadScript(funscriptPath, apiKey) {
    return this._active().uploadScript(funscriptPath, apiKey);
  };

  HybridInteractiveClient.prototype.sync = function sync() {
    return this._active().sync();
  };

  HybridInteractiveClient.prototype.configure = function configure(config) {
    var tasks = [this._ossmClient.configure(config)];
    if (this._fallbackClient && typeof this._fallbackClient.configure === 'function') {
      tasks.push(this._fallbackClient.configure(config));
    }
    return Promise.all(tasks).then(function done() {
      return undefined;
    });
  };

  HybridInteractiveClient.prototype.play = function play(position) {
    return this._active().play(position);
  };

  HybridInteractiveClient.prototype.pause = function pause() {
    return this._active().pause();
  };

  HybridInteractiveClient.prototype.ensurePlaying = function ensurePlaying(position) {
    return this._active().ensurePlaying(position);
  };

  HybridInteractiveClient.prototype.setLooping = function setLooping(looping) {
    return this._active().setLooping(looping);
  };

  function OssmInteractiveBootstrap() {
    var interactiveState = useInteractive ? useInteractive() : null;
    var bootstrapPendingRef = useRef(false);

    useEffect(function bootstrapInteractiveState() {
      if (!interactiveState || !interactiveState.interactive) {
        return;
      }

      if (interactiveState.interactive.handyKey !== 'ossm' || interactiveState.initialised) {
        bootstrapPendingRef.current = false;
        return;
      }

      if (!interactiveState.serverOffset || bootstrapPendingRef.current) {
        return;
      }

      bootstrapPendingRef.current = true;
      Promise.resolve(interactiveState.initialise())
        .catch(function ignore() {
          return null;
        })
        .finally(function clearBootstrapPending() {
          bootstrapPendingRef.current = false;
        });
    }, [
      interactiveState ? interactiveState.initialised : false,
      interactiveState ? interactiveState.initialise : null,
      interactiveState && interactiveState.interactive ? interactiveState.interactive.handyKey : '',
      interactiveState ? interactiveState.serverOffset : 0,
    ]);

    return null;
  }

  function useRuntimeSnapshot() {
    if (typeof useSyncExternalStore === 'function') {
      return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
    }

    var stateTuple = useState(runtime.getSnapshot());
    var snapshot = stateTuple[0];
    var setSnapshot = stateTuple[1];

    useEffect(function subscribeToStore() {
      return runtime.subscribe(function handleStoreChange() {
        setSnapshot(runtime.getSnapshot());
      });
    }, []);

    return snapshot;
  }

  function Stat(props) {
    return h('div', { className: 'ossm-stat', key: 'body' }, [
      h('div', { className: 'text-muted small text-uppercase font-weight-bold mb-1', key: 'label' }, props.label),
      h('div', { className: 'font-weight-bold', key: 'value' }, props.value),
    ]);
  }

  function NumberField(props) {
    return h('div', { className: 'form-group mb-0 ossm-field' }, [
      h('label', { className: 'mb-1', htmlFor: props.id, key: 'label' }, props.label),
      h('input', {
        className: 'form-control',
        id: props.id,
        key: 'input',
        max: props.max,
        min: props.min,
        onChange: props.onChange,
        step: props.step || 1,
        type: 'number',
        value: props.value,
      }),
      props.help ? h('small', { className: 'form-text text-muted mt-1 mb-0', key: 'help' }, props.help) : null,
    ]);
  }

  function SliderField(props) {
    var liveValueState = useState(props.value);
    var liveValue = liveValueState[0];
    var setLiveValue = liveValueState[1];

    useEffect(function syncSliderValue() {
      setLiveValue(props.value);
    }, [props.value]);

    function commitValue(nextValue) {
      if (typeof props.onCommit === 'function') {
        props.onCommit(nextValue);
      }
    }

    function handleLiveChange(nextValue) {
      setLiveValue(nextValue);
      if (props.commitOnChange) {
        commitValue(nextValue);
      }
    }

    return h('div', { className: 'form-group mb-0 ossm-field' }, [
      h('div', { className: 'd-flex align-items-center justify-content-between mb-1', key: 'header' }, [
        h('label', { className: 'mb-0', htmlFor: props.id, key: 'label' }, props.label),
        h('span', { className: 'ossm-slider__value text-muted', key: 'value' }, String(liveValue) + (props.unit || '')),
      ]),
      h('input', {
        className: 'custom-range ossm-slider',
        id: props.id,
        key: 'input',
        max: props.max,
        min: props.min,
        onBlur: function onBlur(event) {
          commitValue(event.target.value);
        },
        onChange: function onChange(event) {
          handleLiveChange(toInteger(event.target.value, props.value));
        },
        onKeyUp: function onKeyUp(event) {
          commitValue(event.target.value);
        },
        onMouseUp: function onMouseUp(event) {
          commitValue(event.target.value);
        },
        onTouchEnd: function onTouchEnd(event) {
          commitValue(event.target.value);
        },
        step: props.step || 1,
        type: 'range',
        value: liveValue,
      }),
      props.help ? h('small', { className: 'form-text text-muted mt-1 mb-0', key: 'help' }, props.help) : null,
    ]);
  }

  function ToggleField(props) {
    return h('div', { className: 'ossm-toggle d-flex justify-content-between align-items-start' }, [
      h('div', { className: 'ossm-toggle__copy mr-3', key: 'copy' }, [
        h(
          'label',
          { className: 'mb-0 font-weight-bold ossm-toggle__title', htmlFor: props.id, key: 'label' },
          props.label
        ),
        props.help ? h('small', { className: 'form-text text-muted mt-1 mb-0', key: 'help' }, props.help) : null,
      ]),
      h('div', { className: 'custom-control custom-switch', key: 'switch' }, [
        h('input', {
          checked: props.checked,
          className: 'custom-control-input',
          disabled: props.disabled,
          id: props.id,
          key: 'input',
          onChange: props.onChange,
          type: 'checkbox',
        }),
        h('label', {
          className: 'custom-control-label',
          htmlFor: props.id,
          key: 'switch-label',
        }),
      ]),
    ]);
  }

  function toggleId(name) {
    return (
      'ossm-toggle-' +
      String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    );
  }

  function renderLogs(logs) {
    if (!logs.length) {
      return 'No OSSM activity yet.';
    }

    return logs
      .map(function mapLog(log) {
        return '[' + log.timestamp + '] ' + log.direction + '  ' + log.message;
      })
      .join('\n');
  }

  function statusClass(status, error) {
    var baseClassName = 'badge badge-pill ossm-status';
    if (error) {
      return baseClassName + ' ossm-status--error';
    }
    if (status === 'connected') {
      return baseClassName + ' ossm-status--connected';
    }
    if (status === 'connecting') {
      return baseClassName + ' ossm-status--connecting';
    }
    return baseClassName;
  }

  function statusLabel(snapshot) {
    if (snapshot.error) {
      return 'Error';
    }
    if (snapshot.connectionStatus === 'connected') {
      return snapshot.deviceName ? 'Connected to ' + snapshot.deviceName : 'Connected';
    }
    if (snapshot.connectionStatus === 'connecting') {
      return 'Connecting';
    }
    return 'Disconnected';
  }

  function navbarStatusClass(snapshot) {
    if (snapshot.error) {
      return 'ossm-nav__dot ossm-nav__dot--error';
    }
    if (snapshot.connectionStatus === 'connected') {
      return 'ossm-nav__dot ossm-nav__dot--connected';
    }
    if (snapshot.connectionStatus === 'connecting') {
      return 'ossm-nav__dot ossm-nav__dot--connecting';
    }
    return 'ossm-nav__dot';
  }

  function navbarAction(snapshot) {
    if (!snapshot.supported) {
      return 'unsupported';
    }

    if (snapshot.connectionStatus === 'connecting') {
      return 'connecting';
    }

    if (snapshot.connectionStatus === 'connected') {
      return snapshot.isPlaying ? 'stop' : 'disconnect';
    }

    return 'connect';
  }

  function navbarActionLabel(snapshot) {
    var action = navbarAction(snapshot);
    if (action === 'connecting') {
      return 'Connecting';
    }
    if (action === 'stop') {
      return 'Stop';
    }
    if (action === 'disconnect') {
      return 'Disconnect';
    }
    if (action === 'unsupported') {
      return 'Unavailable';
    }
    return 'Connect';
  }

  function runNavbarAction(snapshot) {
    var action = navbarAction(snapshot);
    if (action === 'connect') {
      return runtime.connect();
    }
    if (action === 'stop') {
      return runtime.stop();
    }
    if (action === 'disconnect') {
      return runtime.disconnect();
    }
    return Promise.resolve();
  }

  function OssmNavButton() {
    var snapshot = useRuntimeSnapshot();

    var action = navbarAction(snapshot);

    return h(
      'div',
      { className: 'nav-link nav-utility' },
      h(
        'button',
        {
          className:
            'minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary ossm-nav__button',
          disabled: action === 'connecting' || action === 'unsupported',
          onClick: function onClick() {
            runNavbarAction(snapshot).catch(function ignore() {
              return null;
            });
          },
          title: 'OSSM ' + navbarActionLabel(snapshot),
          type: 'button',
        },
        [
          h('span', { className: navbarStatusClass(snapshot), key: 'dot' }),
          h('span', { key: 'label' }, navbarActionLabel(snapshot)),
        ]
      )
    );
  }

  function OssmSceneDetailsPanel() {
    var snapshot = useRuntimeSnapshot();
    var settings = snapshot.settings;
    var action = navbarAction(snapshot);

    return h('section', { className: 'container ossm-scene-panel' }, [
      h('div', { className: 'row form-group', key: 'header' }, [
        h('span', { className: 'col-12 d-flex align-items-center justify-content-between', key: 'header-col' }, [
          h('h5', { className: 'mb-0', key: 'title' }, 'OSSM'),
          h('span', { className: 'd-flex align-items-center ossm-scene-panel__header-actions', key: 'controls' }, [
            h('span', { className: statusClass(snapshot.connectionStatus, snapshot.error), key: 'status' }, [
              h('span', { className: 'ossm-status__dot', key: 'dot' }),
              h('span', { key: 'label' }, statusLabel(snapshot)),
            ]),
            h(
              'button',
              {
                className: 'btn btn-primary btn-sm',
                disabled: action === 'connecting' || action === 'unsupported',
                key: 'connect-button',
                onClick: function onClick() {
                  runNavbarAction(snapshot).catch(function ignore() {
                    return null;
                  });
                },
                type: 'button',
              },
              navbarActionLabel(snapshot)
            ),
          ]),
        ]),
      ]),
      h('div', { className: 'ossm-meta ossm-scene-panel__stats', key: 'stats' }, [
        h(Stat, {
          key: 'position',
          label: 'Position',
          value: String(snapshot.currentPosition || 0) + '%',
        }),
        h(Stat, {
          key: 'actions',
          label: 'Actions',
          value: String(getCurrentActionCount(snapshot)),
        }),
        h(Stat, {
          key: 'sent',
          label: 'Sent',
          value: String(snapshot.commandsSent || 0),
        }),
      ]),
      h('div', { className: 'mt-3', key: 'motion-limits' }, [
        h('h5', { className: 'mb-3', key: 'motion-title' }, 'Motion Limits'),
        h('div', { className: 'ossm-field-grid', key: 'motion-fields' }, [
          h(SliderField, {
            help: 'BLE speed cap for streaming mode. Set to 0 to intentionally stop motion.',
            id: 'ossm-scene-speed',
            key: 'speed',
            label: 'Speed Limit (%)',
            max: 100,
            min: 0,
            onCommit: function onCommit(value) {
              runtime.updateSettings({ speed: clamp(toInteger(value, 100), 0, 100) }, true);
            },
            unit: '%',
            value: settings.speed,
          }),
          h(SliderField, {
            help: 'Minimum streamed depth after remapping the funscript range. 0 is fully retracted.',
            id: 'ossm-scene-output-min',
            key: 'output-min',
            label: 'Min Depth (%)',
            max: 100,
            min: 0,
            onCommit: function onCommit(value) {
              runtime.updateSettings(
                { outputMin: clamp(toInteger(value, 0), 0, 100 - clamp(toInteger(settings.strokeLength, 100), 0, 100)) },
                false
              );
            },
            commitOnChange: true,
            unit: '%',
            value: settings.outputMin,
          }),
          h(SliderField, {
            help: 'Stroke length added on top of the minimum depth. Effective max depth is min depth plus stroke length.',
            id: 'ossm-scene-stroke-length',
            key: 'stroke-length',
            label: 'Stroke Length (%)',
            max: 100,
            min: 0,
            onCommit: function onCommit(value) {
              runtime.updateSettings(
                { strokeLength: clamp(toInteger(value, 100), 0, 100 - clamp(toInteger(settings.outputMin, 0), 0, 100)) },
                false
              );
            },
            commitOnChange: true,
            unit: '%',
            value: settings.strokeLength,
          }),
        ]),
      ]),
      h('div', { className: 'mt-3', key: 'timing-behavior' }, [
        h('h5', { className: 'mb-3', key: 'timing-title' }, 'Timing & Behavior'),
        h('div', { className: 'ossm-field-grid', key: 'timing-fields' }, [
          h(ToggleField, {
            checked: settings.simpleMode,
            help: 'Send only turning points instead of every funscript action.',
            id: toggleId('scene-simple-mode'),
            key: 'simple',
            label: 'Simple Mode',
            onChange: function onChange(event) {
              runtime.updateSettings({ simpleMode: Boolean(event.target.checked) }, false);
            },
          }),
          h(ToggleField, {
            checked: settings.reverse,
            help: 'Invert outgoing stream positions without modifying the funscript itself.',
            id: toggleId('scene-reverse-motion'),
            key: 'reverse',
            label: 'Reverse Motion',
            onChange: function onChange(event) {
              runtime.updateSettings({ reverse: Boolean(event.target.checked) }, false);
            },
          }),
        ]),
      ]),
      h('details', { className: 'ossm-scene-panel__debug mt-3', key: 'advanced-options' }, [
        h('summary', { className: 'ossm-scene-panel__debug-summary', key: 'advanced-summary' }, 'Advanced Options'),
        h('div', { className: 'mt-3 ossm-field-grid', key: 'advanced-fields' }, [
          h(NumberField, {
            help: 'Fine tune playback on top of the Stash interface offset. Positive values send commands later.',
            id: 'ossm-scene-fine-offset',
            key: 'offset',
            label: 'Fine Offset (ms)',
            max: 5000,
            min: -5000,
            onChange: function onChange(event) {
              runtime.updateSettings({ fineOffsetMs: toInteger(event.target.value, 0) }, false);
            },
            value: settings.fineOffsetMs,
          }),
          h(NumberField, {
            help: 'Extra delay also pushed into the OSSM buffer command. The sample player uses this to give the device time to receive the next movement.',
            id: 'ossm-scene-buffer',
            key: 'buffer',
            label: 'Buffer (ms)',
            max: 1000,
            min: 0,
            onChange: function onChange(event) {
              runtime.updateSettings({ bufferMs: clamp(toInteger(event.target.value, 0), 0, 1000) }, true);
            },
            value: settings.bufferMs,
          }),
          h(ToggleField, {
            checked: settings.latencyCompensation,
            help: 'Enable the OSSM latency compensation characteristic for streamed commands.',
            id: toggleId('scene-latency-compensation'),
            key: 'latency',
            label: 'Latency Compensation',
            onChange: function onChange(event) {
              runtime.updateSettings({ latencyCompensation: Boolean(event.target.checked) }, true);
            },
          }),
        ]),
      ]),
      h('details', { className: 'ossm-scene-panel__debug mt-3', key: 'logs' }, [
        h('summary', { className: 'ossm-scene-panel__debug-summary', key: 'summary' }, 'Debug Logs'),
        h('div', { className: 'mt-2', key: 'debug-content' }, [
          snapshot.error ? h('div', { className: 'alert alert-danger mb-2', key: 'error' }, snapshot.error) : null,
          h(
            'div',
            {
              className: 'd-flex flex-wrap align-items-center mb-2 ossm-scene-panel__debug-actions',
              key: 'actions',
            },
            [
              h(
                'button',
                {
                  className: 'btn btn-secondary btn-sm',
                  onClick: function onClearError() {
                    runtime.clearError();
                  },
                  type: 'button',
                },
                'Clear Error'
              ),
              h(
                'button',
                {
                  className: 'btn btn-secondary btn-sm',
                  onClick: function onClearLogs() {
                    runtime.clearLogs();
                  },
                  type: 'button',
                },
                'Clear Logs'
              ),
            ]
          ),
          h('pre', { className: 'form-control ossm-log mb-0', key: 'log' }, renderLogs(snapshot.logs)),
        ]),
      ]),
    ]);
  }

  PluginApi.utils.InteractiveUtils.interactiveClientProvider = function interactiveClientProvider(options) {
    var fallbackClient =
      options && typeof options.defaultClientProvider === 'function' ? options.defaultClientProvider(options) : null;
    return new HybridInteractiveClient(new OssmInteractiveClient(runtime), fallbackClient);
  };

  PluginApi.patch.before('MainNavBar.UtilityItems', function patchUtilityItems(props) {
    return [
      {
        children: h(React.Fragment, null, [
          props.children,
          h(OssmInteractiveBootstrap, { key: 'ossm-interactive-bootstrap' }),
          h(OssmNavButton, { key: 'ossm-navbar-button' }),
        ]),
      },
    ];
  });

  PluginApi.patch.before('ScenePage.Tabs', function patchSceneTabs(props) {
    if (!BootstrapNav || !BootstrapNav.Item || !BootstrapNav.Link) {
      return [props];
    }

    return [
      {
        children: h(React.Fragment, null, [
          props.children,
          h(
            BootstrapNav.Item,
            { key: 'ossm-scene-tab-nav-item' },
            h(BootstrapNav.Link, { eventKey: 'ossm-scene-panel', key: 'ossm-scene-tab-link' }, 'OSSM')
          ),
        ]),
      },
    ];
  });

  PluginApi.patch.before('ScenePage.TabContent', function patchSceneTabContent(props) {
    if (!BootstrapTab || !BootstrapTab.Pane) {
      return [props];
    }

    return [
      {
        children: h(React.Fragment, null, [
          props.children,
          h(
            BootstrapTab.Pane,
            { eventKey: 'ossm-scene-panel', key: 'ossm-scene-tab-content' },
            h(OssmSceneDetailsPanel, { key: 'ossm-scene-details-panel' })
          ),
        ]),
      },
    ];
  });
})();
