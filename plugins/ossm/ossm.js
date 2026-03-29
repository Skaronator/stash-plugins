(function initOssmPlugin() {
  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.React) {
    return;
  }

  var React = PluginApi.React;
  var h = React.createElement;
  var ReactRouterDOM = PluginApi.libraries.ReactRouterDOM || {};
  var Link = ReactRouterDOM.Link;
  var NavLink = ReactRouterDOM.NavLink;
  var useEffect = React.useEffect;
  var useState = React.useState;
  var useSyncExternalStore = React.useSyncExternalStore;

  var SERVICE_UUID = '522b443a-4f53-534d-0001-420badbabe69';
  var COMMAND_CHARACTERISTIC_UUID = '522b443a-4f53-534d-1000-420badbabe69';
  var SPEED_KNOB_CHARACTERISTIC_UUID = '522b443a-4f53-534d-1010-420badbabe69';
  var LATENCY_CHARACTERISTIC_UUID = '522b443a-4f53-534d-1030-420badbabe69';
  var STATE_CHARACTERISTIC_UUID = '522b443a-4f53-534d-2000-420badbabe69';
  var STORAGE_KEY = 'plugin.ossm.settings';
  var LOG_LIMIT = 200;
  var TICK_INTERVAL_MS = 5;
  var encoder = new window.TextEncoder();
  var decoder = new window.TextDecoder();

  var DEFAULT_SETTINGS = {
    fineOffsetMs: 0,
    bufferMs: 0,
    simpleMode: true,
    reverse: false,
    speedKnobAsLimit: false,
    latencyCompensation: true,
    speed: 0,
    stroke: 0,
    depth: 0,
    sensation: 0,
  };

  function readSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return Object.assign({}, DEFAULT_SETTINGS);
      }

      var parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_SETTINGS, parsed || {});
    } catch (error) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function writeSettings(settings) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // Ignore localStorage failures.
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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

  function formatMs(ms) {
    var totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return String(minutes) + ':' + String(seconds).padStart(2, '0');
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
    var currentActionIndex = 0;
    var lastSentActionAt = -1;
    var lastObservedEffectiveTime = 0;

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

      return characteristic.writeValue(encoder.encode(value ? 'true' : 'false'));
    }

    function sendCommand(command) {
      if (!commandCharacteristic) {
        return Promise.resolve(false);
      }

      var payload = encoder.encode(command);
      var writer = commandCharacteristic.writeValueWithoutResponse
        ? commandCharacteristic.writeValueWithoutResponse.bind(commandCharacteristic)
        : commandCharacteristic.writeValue.bind(commandCharacteristic);

      return writer(payload)
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

      var mergedSettings = Object.assign({}, state.settings, nextSettings);
      writeSettings(mergedSettings);
      setState({
        deviceState: deviceState,
        settings: mergedSettings,
      });
    }

    function handleStateCharacteristic(value) {
      var text = decodeCharacteristicValue(value);
      addLog('RX', 'state: ' + text);

      try {
        applyDeviceState(JSON.parse(text));
      } catch (error) {
        addLog('ERR', 'State parse failed: ' + error.message);
      }
    }

    function applyLiveSettings(changes) {
      var operations = [];

      if (Object.prototype.hasOwnProperty.call(changes, 'speedKnobAsLimit')) {
        operations.push(writeBooleanCharacteristic(speedKnobCharacteristic, changes.speedKnobAsLimit));
      }

      if (Object.prototype.hasOwnProperty.call(changes, 'latencyCompensation')) {
        operations.push(writeBooleanCharacteristic(latencyCharacteristic, changes.latencyCompensation));
      }

      if (Object.prototype.hasOwnProperty.call(changes, 'bufferMs')) {
        operations.push(sendCommand('set:buffer:' + clamp(Math.round(changes.bufferMs / 2), 0, 500)));
      }

      ['speed', 'stroke', 'depth', 'sensation'].forEach(function syncKey(key) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          operations.push(sendCommand('set:' + key + ':' + clamp(Math.round(changes[key]), 0, 100)));
        }
      });

      return Promise.all(operations);
    }

    function updateSettings(changes, syncToDevice) {
      var nextSettings = Object.assign({}, state.settings, changes || {});
      writeSettings(nextSettings);
      setState({ settings: nextSettings });

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

    function disconnectInternal() {
      stopSync();

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
      });
      addLog('INFO', 'Device disconnected');
    }

    function onGattDisconnected() {
      disconnectInternal();
    }

    function connect() {
      if (!state.supported) {
        var supportError = new Error('Web Bluetooth is not supported by this browser');
        setError(supportError.message);
        return Promise.reject(supportError);
      }

      if (state.connectionStatus === 'connecting') {
        return Promise.resolve();
      }

      if (server && server.connected) {
        setState({ connectionStatus: 'connected' });
        return Promise.resolve();
      }

      clearError();
      setState({ connectionStatus: 'connecting' });
      addLog('INFO', 'Requesting OSSM device');

      return navigator.bluetooth
        .requestDevice({
          filters: [{ services: [SERVICE_UUID] }],
          optionalServices: [SERVICE_UUID],
        })
        .then(function onDeviceSelected(selectedDevice) {
          device = selectedDevice;
          device.addEventListener('gattserverdisconnected', onGattDisconnected);
          setState({ deviceName: device.name || 'OSSM' });
          addLog('INFO', 'Selected device: ' + (device.name || 'OSSM'));
          return device.gatt.connect();
        })
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

          var operations = [];
          if (stateCharacteristic) {
            stateListener = function onStateChange(event) {
              handleStateCharacteristic(event.target.value);
            };

            operations.push(
              stateCharacteristic
                .readValue()
                .then(handleStateCharacteristic)
                .catch(function ignore() {
                  return null;
                })
            );
            operations.push(
              stateCharacteristic.startNotifications().then(function subscribe() {
                stateCharacteristic.addEventListener('characteristicvaluechanged', stateListener);
              })
            );
          }

          operations.push(sendCommand('go:streaming'));
          operations.push(applyLiveSettings(state.settings));

          return Promise.all(operations);
        })
        .then(function onReady() {
          setState({ connectionStatus: 'connected' });
          addLog('INFO', 'OSSM is ready for streaming mode');
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
            var targetPosition = state.settings.reverse ? 100 - upcomingAction.pos : upcomingAction.pos;
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

      return connect().then(function onConnected() {
        startSync(positionSeconds);
      });
    }

    function pause() {
      stopSync();
      return Promise.resolve();
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

    function sendTestPosition(position) {
      return connect().then(function onConnected() {
        return sendStreamPosition(position, 500);
      });
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
      ensurePlaying: ensurePlaying,
      setLooping: setLooping,
      updateSettings: updateSettings,
      clearLogs: function clearLogs() {
        setState({ logs: [] });
      },
      clearError: clearError,
      sendTestPosition: sendTestPosition,
      sync: function sync() {
        return Promise.resolve(0);
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
    return this._store.connect();
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

  function Card(props) {
    return h('section', { className: 'card h-100 ' + (props.className || '') }, [
      props.title
        ? h(
            'div',
            { className: 'card-header d-flex flex-wrap align-items-center justify-content-between', key: 'head' },
            [
              h(props.headingTag || 'h2', { className: 'h5 mb-0', key: 'title' }, props.title),
              props.actions
                ? h('div', { className: 'd-flex flex-wrap align-items-center', key: 'actions' }, props.actions)
                : null,
            ]
          )
        : null,
      h('div', { className: 'card-body ' + (props.bodyClassName || ''), key: 'body' }, props.children),
    ]);
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

  function RangeField(props) {
    return h('div', { className: 'form-group mb-0 ossm-field' }, [
      h('label', { className: 'mb-1', htmlFor: props.id, key: 'label' }, props.label),
      props.help ? h('small', { className: 'form-text text-muted mt-0 mb-1', key: 'help' }, props.help) : null,
      h('div', { className: 'ossm-range-wrap d-flex align-items-center', key: 'wrap' }, [
        h('input', {
          className: 'custom-range ossm-range',
          disabled: props.disabled,
          id: props.id,
          max: props.max,
          min: props.min,
          onChange: props.onChange,
          step: props.step || 1,
          type: 'range',
          value: props.value,
        }),
        h(
          'span',
          { className: 'text-muted small ml-2 ossm-range-value', key: 'value' },
          String(props.value) + props.suffix
        ),
      ]),
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

  function OssmNavButton() {
    var snapshot = useRuntimeSnapshot();

    if (!NavLink) {
      return null;
    }

    return h(
      NavLink,
      {
        className: 'nav-utility ossm-nav__link',
        exact: true,
        title: 'Open OSSM controls',
        to: '/plugin/ossm',
      },
      h(
        'button',
        {
          className: 'minimal d-flex align-items-center h-100 ossm-nav__button',
          type: 'button',
        },
        [
          h('span', { className: navbarStatusClass(snapshot), key: 'dot' }),
          h('span', { className: 'ossm-nav__label', key: 'label' }, 'OSSM'),
        ]
      )
    );
  }

  function OssmPage() {
    var snapshot = useRuntimeSnapshot();
    var settings = snapshot.settings;
    var connected = snapshot.connectionStatus === 'connected';
    var showUsage = !isOssmConnectionKey(snapshot.connectionKey);
    var scriptOffsetCopy = snapshot.scriptOffsetMs === 0 ? '0 ms' : String(snapshot.scriptOffsetMs) + ' ms';
    var totalOffsetCopy = String(snapshot.scriptOffsetMs + settings.fineOffsetMs + settings.bufferMs) + ' ms';

    var usageLink = Link
      ? h(Link, { className: 'btn btn-secondary btn-sm', to: '/settings?tab=interface' }, 'Open Interface Settings')
      : null;

    return h('div', { className: 'ossm-page' }, [
      h('div', { className: 'ossm-shell', key: 'shell' }, [
        h(
          'header',
          { className: 'ossm-hero d-flex flex-wrap justify-content-between align-items-start mb-3', key: 'hero' },
          [
            h('div', { key: 'copy' }, [
              h(
                'div',
                { className: 'ossm-kicker text-muted small text-uppercase font-weight-bold', key: 'kicker' },
                'Stash Interactive Plugin'
              ),
              h('h1', { className: 'ossm-title mb-0', key: 'title' }, 'OSSM over Web Bluetooth'),
              h(
                'p',
                { className: 'ossm-lead text-muted mt-2 mb-0', key: 'lead' },
                "This page controls the OSSM runtime used by Stash's interactive scene player. Set the Handy connection key to ossm to route funscript playback through this plugin while keeping the built-in Handy client available for every other key."
              ),
            ]),
            h('div', { className: statusClass(snapshot.connectionStatus, snapshot.error), key: 'status' }, [
              h('span', { className: 'ossm-status__dot', key: 'dot' }),
              h('span', { key: 'label' }, statusLabel(snapshot)),
            ]),
          ]
        ),

        !snapshot.supported
          ? h(
              'div',
              { className: 'alert alert-warning mb-3', key: 'unsupported' },
              'Web Bluetooth is not available in this browser. Use a current Chromium-based browser on desktop or Android.'
            )
          : null,
        snapshot.error ? h('div', { className: 'alert alert-danger mb-3', key: 'error' }, snapshot.error) : null,

        h('div', { className: 'row', key: 'grid' }, [
          showUsage
            ? h(
                'div',
                { className: 'col-12 mb-3', key: 'usage' },
                h(
                  Card,
                  {
                    title: 'Usage',
                    actions: usageLink,
                  },
                  [
                    h('ol', { className: 'ossm-list text-muted mb-0', key: 'steps' }, [
                      h('li', { key: 'one' }, 'Set the Handy connection key in Stash to ossm.'),
                      h('li', { key: 'two' }, 'Open an interactive scene with a funscript served by Stash.'),
                      h(
                        'li',
                        { key: 'three' },
                        'Approve the Bluetooth pairing prompt the first time the browser asks for the device.'
                      ),
                      h(
                        'li',
                        { key: 'four' },
                        'Use the controls below for fine offset, buffer, simple mode, reverse, and live device tuning.'
                      ),
                    ]),
                  ]
                )
              )
            : null,
          h(
            'div',
            { className: 'col-xl-6 col-lg-12 mb-3', key: 'connection' },
            h(
              Card,
              {
                className: 'ossm-card--dense',
                bodyClassName: 'p-3',
                title: 'Connection',
                actions: h('div', { className: 'd-flex flex-wrap align-items-center', style: { gap: '0.5rem' } }, [
                  h(
                    'button',
                    {
                      className: 'btn btn-primary btn-sm',
                      disabled: !snapshot.supported || snapshot.connectionStatus === 'connecting',
                      onClick: function onConnect() {
                        runtime.connect().catch(function ignore() {
                          return null;
                        });
                      },
                      type: 'button',
                    },
                    connected ? 'Reconnect' : 'Connect'
                  ),
                  h(
                    'button',
                    {
                      className: 'btn btn-secondary btn-sm',
                      disabled: !connected,
                      onClick: function onDisconnect() {
                        runtime.disconnect().catch(function ignore() {
                          return null;
                        });
                      },
                      type: 'button',
                    },
                    'Disconnect'
                  ),
                ]),
              },
              [
                h('div', { className: 'ossm-meta', key: 'meta' }, [
                  h(Stat, { key: 'device', label: 'Device', value: snapshot.deviceName || 'Not paired' }),
                  h(Stat, {
                    key: 'key',
                    label: 'Activation Key',
                    value: snapshot.connectionKey || 'Set Handy key to ossm',
                  }),
                  h(Stat, { key: 'stash-offset', label: 'Stash Offset', value: scriptOffsetCopy }),
                  h(Stat, { key: 'total-offset', label: 'Effective Offset', value: totalOffsetCopy }),
                ]),
                h('div', { className: 'ossm-actions', key: 'transport' }, [
                  h(
                    'button',
                    {
                      className: 'btn btn-secondary btn-sm',
                      disabled: !connected,
                      onClick: function onHome() {
                        runtime.sendTestPosition(0).catch(function ignore() {
                          return null;
                        });
                      },
                      type: 'button',
                    },
                    'Home'
                  ),
                  h(
                    'button',
                    {
                      className: 'btn btn-secondary btn-sm',
                      disabled: !connected,
                      onClick: function onMid() {
                        runtime.sendTestPosition(50).catch(function ignore() {
                          return null;
                        });
                      },
                      type: 'button',
                    },
                    'Mid'
                  ),
                  h(
                    'button',
                    {
                      className: 'btn btn-secondary btn-sm',
                      disabled: !connected,
                      onClick: function onOut() {
                        runtime.sendTestPosition(100).catch(function ignore() {
                          return null;
                        });
                      },
                      type: 'button',
                    },
                    'Out'
                  ),
                ]),
              ]
            )
          ),

          h(
            'div',
            { className: 'col-xl-6 col-lg-12 mb-3', key: 'playback-script' },
            h(Card, { className: 'ossm-card--dense', bodyClassName: 'p-0', title: 'Playback & Script' }, [
              h('div', { className: 'ossm-playback', key: 'main-row' }, [
                h('div', { className: 'ossm-meta ossm-playback__stats', key: 'stats-col' }, [
                  h(Stat, { key: 'actions', label: 'Actions', value: String(snapshot.actionCount || 0) }),
                  h(Stat, { key: 'simple-actions', label: 'Simple', value: String(snapshot.simpleActionCount || 0) }),
                  h(Stat, { key: 'mode', label: 'Mode', value: settings.simpleMode ? 'Simple' : 'Full' }),
                  h(Stat, { key: 'current-time', label: 'Video Time', value: formatMs(snapshot.currentTimeMs) }),
                  h(Stat, { key: 'position', label: 'Target Pos', value: String(snapshot.currentPosition) + '%' }),
                  h(Stat, { key: 'sent', label: 'Cmds Sent', value: String(snapshot.commandsSent) }),
                ]),
                h('div', { className: 'ossm-stat ossm-playback__script', key: 'script-col' }, [
                  h('div', { className: 'text-muted small text-uppercase font-weight-bold mb-1', key: 'kicker' }, 'Script'),
                  h(
                    'div',
                    {
                      className: 'font-weight-bold',
                      key: 'name',
                      title: snapshot.currentScriptPath || 'No script loaded',
                    },
                    shortFileName(snapshot.currentScriptPath)
                  ),
                  h(
                    'span',
                    {
                      className:
                        'text-muted small d-block mt-1 ossm-playback__script-path' +
                        (snapshot.currentScriptPath ? '' : ' ossm-playback__script-path--empty'),
                      key: 'path',
                      title: snapshot.currentScriptPath || '',
                    },
                    snapshot.currentScriptPath
                      ? snapshot.currentScriptPath
                      : 'No funscript has been loaded by the scene player yet.'
                  ),
                ]),
              ]),
            ])
          ),

          h(
            'div',
            { className: 'col-xl-6 col-lg-12 mb-3', key: 'timing' },
            h(Card, { title: 'Timing & Behavior' }, [
              h('div', { className: 'ossm-field-grid', key: 'fields' }, [
                h(NumberField, {
                  help: 'Fine tune playback on top of the Stash interface offset. Positive values send commands later.',
                  id: 'ossm-fine-offset',
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
                  id: 'ossm-buffer',
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
                  checked: settings.simpleMode,
                  help: 'Send only turning points instead of every funscript action.',
                  id: toggleId('simple-mode'),
                  key: 'simple',
                  label: 'Simple Mode',
                  onChange: function onChange(event) {
                    runtime.updateSettings({ simpleMode: Boolean(event.target.checked) }, false);
                  },
                }),
                h(ToggleField, {
                  checked: settings.reverse,
                  help: 'Invert outgoing stream positions without modifying the funscript itself.',
                  id: toggleId('reverse-motion'),
                  key: 'reverse',
                  label: 'Reverse Motion',
                  onChange: function onChange(event) {
                    runtime.updateSettings({ reverse: Boolean(event.target.checked) }, false);
                  },
                }),
                h(ToggleField, {
                  checked: settings.speedKnobAsLimit,
                  help: 'Keep the physical OSSM speed knob as an upper limit for BLE speed commands.',
                  id: toggleId('use-speed-knob-as-limit'),
                  key: 'knob-limit',
                  label: 'Use Speed Knob As Limit',
                  onChange: function onChange(event) {
                    runtime.updateSettings({ speedKnobAsLimit: Boolean(event.target.checked) }, true);
                  },
                }),
                h(ToggleField, {
                  checked: settings.latencyCompensation,
                  help: 'Enable the OSSM latency compensation characteristic for streamed commands.',
                  id: toggleId('latency-compensation'),
                  key: 'latency',
                  label: 'Latency Compensation',
                  onChange: function onChange(event) {
                    runtime.updateSettings({ latencyCompensation: Boolean(event.target.checked) }, true);
                  },
                }),
              ]),
            ])
          ),

          h(
            'div',
            { className: 'col-xl-6 col-lg-12 mb-3', key: 'device-controls' },
            h(Card, { className: 'ossm-card--compact-controls', title: 'Device Controls' }, [
              h('div', { className: 'ossm-field-grid', key: 'ranges' }, [
                h(RangeField, {
                  disabled: !connected,
                  help: 'Live OSSM speed percentage.',
                  id: 'ossm-speed',
                  key: 'speed',
                  label: 'Speed',
                  max: 100,
                  min: 0,
                  onChange: function onChange(event) {
                    runtime.updateSettings({ speed: clamp(toInteger(event.target.value, 0), 0, 100) }, true);
                  },
                  suffix: '%',
                  value: settings.speed,
                }),
                h(RangeField, {
                  disabled: !connected,
                  help: 'Live OSSM stroke percentage.',
                  id: 'ossm-stroke',
                  key: 'stroke',
                  label: 'Stroke',
                  max: 100,
                  min: 0,
                  onChange: function onChange(event) {
                    runtime.updateSettings({ stroke: clamp(toInteger(event.target.value, 0), 0, 100) }, true);
                  },
                  suffix: '%',
                  value: settings.stroke,
                }),
                h(RangeField, {
                  disabled: !connected,
                  help: 'Live OSSM depth percentage.',
                  id: 'ossm-depth',
                  key: 'depth',
                  label: 'Depth',
                  max: 100,
                  min: 0,
                  onChange: function onChange(event) {
                    runtime.updateSettings({ depth: clamp(toInteger(event.target.value, 0), 0, 100) }, true);
                  },
                  suffix: '%',
                  value: settings.depth,
                }),
                h(RangeField, {
                  disabled: !connected,
                  help: 'Live OSSM sensation percentage.',
                  id: 'ossm-sensation',
                  key: 'sensation',
                  label: 'Sensation',
                  max: 100,
                  min: 0,
                  onChange: function onChange(event) {
                    runtime.updateSettings({ sensation: clamp(toInteger(event.target.value, 0), 0, 100) }, true);
                  },
                  suffix: '%',
                  value: settings.sensation,
                }),
              ]),
            ])
          ),

          h(
            'div',
            { className: 'col-12 mb-3', key: 'logs' },
            h(
              Card,
              {
                title: 'Logs',
                actions: h('div', { className: 'd-flex flex-wrap align-items-center', style: { gap: '0.5rem' } }, [
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
                ]),
              },
              [h('pre', { className: 'form-control ossm-log mb-0', key: 'log' }, renderLogs(snapshot.logs))]
            )
          ),
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
        children: h(React.Fragment, null, [props.children, h(OssmNavButton, { key: 'ossm-navbar-button' })]),
      },
    ];
  });

  PluginApi.register.route('/plugin/ossm', OssmPage);
})();
