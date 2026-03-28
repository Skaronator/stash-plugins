(function () {
  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.utils || !PluginApi.utils.InteractiveUtils) {
    return;
  }

  var React = PluginApi.React;
  var createElement = React.createElement;
  var Button = PluginApi.libraries.Bootstrap.Button;
  var useInteractive = PluginApi.hooks.useInteractive;
  var useSettings = PluginApi.hooks.useSettings;

  var PLUGIN_ID = "ossm-interactive";
  var STORAGE_KEY = "stash.plugin.ossm-interactive";
  var SERVICE_UUID = "522b443a-4f53-534d-0001-420badbabe69";
  var COMMAND_UUID = "522b443a-4f53-534d-1000-420badbabe69";
  var LATENCY_UUID = "522b443a-4f53-534d-1030-420badbabe69";
  var STATE_UUID = "522b443a-4f53-534d-2000-420badbabe69";

  var ConnectionState = {
    Missing: 0,
    Disconnected: 1,
    Error: 2,
    Connecting: 3,
    Syncing: 4,
    Uploading: 5,
    Ready: 6,
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function convertRange(value, fromLow, fromHigh, toLow, toHigh) {
    if (fromHigh === fromLow) {
      return toLow;
    }

    return ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow) + toLow;
  }

  function normaliseSettings(settings) {
    var input = settings || {};
    var prefix = typeof input.deviceNamePrefix === "string" && input.deviceNamePrefix.trim()
      ? input.deviceNamePrefix.trim()
      : "OSSM";

    return {
      enableOSSM: input.enableOSSM === true,
      latencyCompensation: input.latencyCompensation === true,
      deviceNamePrefix: prefix,
    };
  }

  function loadPersistedSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return normaliseSettings({});
      }

      return normaliseSettings(JSON.parse(raw));
    } catch (_error) {
      return normaliseSettings({});
    }
  }

  var runtimeSettings = loadPersistedSettings();

  function persistSettings(settings) {
    runtimeSettings = normaliseSettings(settings);

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(runtimeSettings));
    } catch (_error) {
      // Ignore storage failures and continue with in-memory settings.
    }
  }

  function getRuntimeSettings() {
    return runtimeSettings;
  }

  function stateLabel(state) {
    switch (state) {
      case ConnectionState.Connecting:
        return "Connecting";
      case ConnectionState.Syncing:
        return "Preparing";
      case ConnectionState.Uploading:
        return "Loading script";
      case ConnectionState.Ready:
        return "Ready";
      case ConnectionState.Error:
        return "Error";
      case ConnectionState.Disconnected:
        return "Disconnected";
      case ConnectionState.Missing:
      default:
        return "Not connected";
    }
  }

  function isBluetoothSupported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  function isSecureBluetoothContext() {
    return typeof window !== "undefined" && !!window.isSecureContext;
  }

  function getPlaybackRate() {
    try {
      var player = PluginApi.utils.InteractiveUtils.getPlayer();
      if (player && typeof player.playbackRate === "function") {
        var value = Number(player.playbackRate());
        if (Number.isFinite(value) && value > 0) {
          return value;
        }
      }
    } catch (_error) {
      // Ignore lookup failures and fall back to normal speed.
    }

    return 1;
  }

  function clearTimers(timers) {
    while (timers.length > 0) {
      window.clearTimeout(timers.pop());
    }
  }

  function decodeText(dataView) {
    return new TextDecoder().decode(
      dataView.buffer.slice(dataView.byteOffset, dataView.byteOffset + dataView.byteLength)
    );
  }

  function normaliseFunscript(funscript) {
    if (!funscript || !Array.isArray(funscript.actions) || funscript.actions.length === 0) {
      throw new Error("Invalid funscript");
    }

    var actions = funscript.actions
      .slice()
      .sort(function (left, right) {
        return left.at - right.at;
      })
      .map(function (action) {
        var position = Number(action.pos);

        if (funscript.inverted === true) {
          position = convertRange(position, 0, 100, 100, 0);
        }

        if (funscript.range) {
          position = convertRange(position, 0, funscript.range, 0, 100);
        }

        return {
          at: Math.max(0, Math.round(Number(action.at) || 0)),
          pos: clamp(Math.round(position), 0, 100),
        };
      });

    if (actions.length === 0) {
      throw new Error("Funscript has no actions");
    }

    return actions;
  }

  function interpolatePosition(start, end, targetTime) {
    if (!start) {
      return end ? end.pos : 0;
    }

    if (!end || end.at === start.at) {
      return start.pos;
    }

    var progress = (targetTime - start.at) / (end.at - start.at);
    return Math.round(start.pos + (end.pos - start.pos) * progress);
  }

  function buildPlaybackPlan(actions, offsetMs) {
    if (!actions || actions.length === 0) {
      return { initialPosition: 0, segments: [] };
    }

    var segments = [];
    var initialPosition = actions[0].pos;

    if (offsetMs <= actions[0].at) {
      initialPosition = actions[0].pos;
      for (var startIndex = 0; startIndex < actions.length - 1; startIndex += 1) {
        segments.push({
          delay: Math.max(0, actions[startIndex].at - offsetMs),
          position: actions[startIndex + 1].pos,
          duration: Math.max(1, actions[startIndex + 1].at - actions[startIndex].at),
        });
      }

      return {
        initialPosition: initialPosition,
        segments: segments,
      };
    }

    if (offsetMs >= actions[actions.length - 1].at) {
      return {
        initialPosition: actions[actions.length - 1].pos,
        segments: [],
      };
    }

    for (var index = 0; index < actions.length - 1; index += 1) {
      var current = actions[index];
      var next = actions[index + 1];

      if (offsetMs >= current.at && offsetMs <= next.at) {
        initialPosition = interpolatePosition(current, next, offsetMs);

        segments.push({
          delay: 0,
          position: next.pos,
          duration: Math.max(1, next.at - offsetMs),
        });

        for (var followIndex = index + 1; followIndex < actions.length - 1; followIndex += 1) {
          segments.push({
            delay: Math.max(0, actions[followIndex].at - offsetMs),
            position: actions[followIndex + 1].pos,
            duration: Math.max(1, actions[followIndex + 1].at - actions[followIndex].at),
          });
        }

        break;
      }
    }

    return {
      initialPosition: initialPosition,
      segments: segments,
    };
  }

  function OssmInteractiveClient(scriptOffset) {
    this._connected = false;
    this._playing = false;
    this._scriptOffset = scriptOffset || 0;
    this._device = null;
    this._server = null;
    this._commandCharacteristic = null;
    this._latencyCharacteristic = null;
    this._stateCharacteristic = null;
    this._deviceName = "";
    this._actions = [];
    this._timers = [];
    this._playbackSession = 0;
    this._streamingPrepared = false;

    this._onDisconnected = this._handleDisconnected.bind(this);
  }

  Object.defineProperty(OssmInteractiveClient.prototype, "connected", {
    get: function () {
      return this._connected;
    },
  });

  Object.defineProperty(OssmInteractiveClient.prototype, "playing", {
    get: function () {
      return this._playing;
    },
  });

  Object.defineProperty(OssmInteractiveClient.prototype, "handyKey", {
    get: function () {
      return this._connected ? (this._deviceName || "OSSM") : "";
    },
    set: function (_key) {
      // OSSM uses browser-selected Web Bluetooth devices rather than a shared connection key.
    },
  });

  Object.defineProperty(OssmInteractiveClient.prototype, "scriptOffset", {
    set: function (offset) {
      this._scriptOffset = Number(offset) || 0;
    },
  });

  OssmInteractiveClient.prototype._handleDisconnected = function () {
    this._connected = false;
    this._playing = false;
    this._streamingPrepared = false;
    clearTimers(this._timers);
  };

  OssmInteractiveClient.prototype._writeCharacteristic = function (characteristic, text) {
    var encoded = new TextEncoder().encode(text);

    if (typeof characteristic.writeValueWithResponse === "function") {
      return characteristic.writeValueWithResponse(encoded);
    }

    if (typeof characteristic.writeValue === "function") {
      return characteristic.writeValue(encoded);
    }

    return characteristic.writeValueWithoutResponse(encoded);
  };

  OssmInteractiveClient.prototype._writeCommand = function (command) {
    if (!this._commandCharacteristic) {
      return Promise.reject(new Error("OSSM command characteristic is unavailable"));
    }

    return this._writeCharacteristic(this._commandCharacteristic, command);
  };

  OssmInteractiveClient.prototype._readState = function () {
    var _this = this;
    if (!this._stateCharacteristic || typeof this._stateCharacteristic.readValue !== "function") {
      return Promise.resolve(null);
    }

    return this._stateCharacteristic.readValue().then(function (value) {
      try {
        return JSON.parse(decodeText(value));
      } catch (_error) {
        return null;
      }
    }).catch(function () {
      return _this._stateCharacteristic.readValue().then(function (value) {
        try {
          return JSON.parse(decodeText(value));
        } catch (_error) {
          return null;
        }
      }).catch(function () {
        return null;
      });
    });
  };

  OssmInteractiveClient.prototype._waitForStreamingState = function () {
    var _this = this;
    var start = Date.now();

    function poll() {
      return _this._readState().then(function (state) {
        if (!state || typeof state.state !== "string") {
          return null;
        }

        if (state.state.indexOf("streaming") === 0) {
          return state;
        }

        if (Date.now() - start > 3000) {
          return null;
        }

        return new Promise(function (resolve) {
          window.setTimeout(function () {
            resolve(poll());
          }, 150);
        });
      });
    }

    return poll();
  };

  OssmInteractiveClient.prototype._applyDeviceSettings = function () {
    var settings = getRuntimeSettings();
    if (!this._latencyCharacteristic) {
      return Promise.resolve();
    }

    return this._writeCharacteristic(
      this._latencyCharacteristic,
      settings.latencyCompensation ? "true" : "false"
    ).catch(function () {
      // Ignore optional setting failures.
    });
  };

  OssmInteractiveClient.prototype._connectGatt = function () {
    var _this = this;
    if (!this._device || !this._device.gatt) {
      return Promise.reject(new Error("No OSSM device selected"));
    }

    if (this._device.gatt.connected && this._server && this._commandCharacteristic) {
      this._connected = true;
      return Promise.resolve();
    }

    return this._device.gatt.connect().then(function (server) {
      _this._server = server;
      return server.getPrimaryService(SERVICE_UUID);
    }).then(function (service) {
      return Promise.all([
        service.getCharacteristic(COMMAND_UUID),
        service.getCharacteristic(LATENCY_UUID).catch(function () {
          return null;
        }),
        service.getCharacteristic(STATE_UUID).catch(function () {
          return null;
        }),
      ]);
    }).then(function (characteristics) {
      _this._commandCharacteristic = characteristics[0];
      _this._latencyCharacteristic = characteristics[1];
      _this._stateCharacteristic = characteristics[2];
      _this._deviceName = _this._device && _this._device.name ? _this._device.name : getRuntimeSettings().deviceNamePrefix;
      _this._connected = true;
      return _this._applyDeviceSettings();
    }).then(function () {
      return undefined;
    });
  };

  OssmInteractiveClient.prototype.connect = function () {
    var _this = this;
    var settings = getRuntimeSettings();

    if (!isBluetoothSupported()) {
      return Promise.reject(new Error("Web Bluetooth is not available in this browser"));
    }

    if (!isSecureBluetoothContext()) {
      return Promise.reject(new Error("Web Bluetooth requires HTTPS or localhost"));
    }

    if (this._device) {
      return this._connectGatt();
    }

    return navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: settings.deviceNamePrefix }],
      optionalServices: [SERVICE_UUID],
    }).then(function (device) {
      _this._device = device;
      _this._deviceName = device.name || settings.deviceNamePrefix;
      device.removeEventListener("gattserverdisconnected", _this._onDisconnected);
      device.addEventListener("gattserverdisconnected", _this._onDisconnected);
      return _this._connectGatt();
    });
  };

  OssmInteractiveClient.prototype._ensureStreamingMode = function () {
    var _this = this;
    if (this._streamingPrepared) {
      return Promise.resolve();
    }

    return this._writeCommand("go:streaming")
      .then(function () {
        return _this._waitForStreamingState();
      })
      .catch(function () {
        return null;
      })
      .then(function () {
        _this._streamingPrepared = true;
      });
  };

  OssmInteractiveClient.prototype.uploadScript = function (funscriptPath) {
    var _this = this;
    if (!this._connected) {
      return Promise.reject(new Error("OSSM is not connected"));
    }

    return fetch(funscriptPath)
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Unable to load funscript");
        }

        return response.json();
      })
      .then(function (json) {
        _this._actions = normaliseFunscript(json);
        return _this._ensureStreamingMode();
      });
  };

  OssmInteractiveClient.prototype.sync = function () {
    return Promise.resolve(1);
  };

  OssmInteractiveClient.prototype.configure = function (config) {
    if (typeof config.scriptOffset === "number") {
      this._scriptOffset = config.scriptOffset;
    }

    if (this._connected) {
      return this._applyDeviceSettings().then(function () {
        return undefined;
      });
    }

    return Promise.resolve();
  };

  OssmInteractiveClient.prototype._sendStream = function (position, duration) {
    return this._writeCommand(
      "stream:" + clamp(Math.round(position), 0, 100) + ":" + Math.max(1, Math.round(duration))
    );
  };

  OssmInteractiveClient.prototype.play = function (position) {
    var _this = this;
    if (!this._connected || !this._actions || this._actions.length === 0) {
      return Promise.resolve();
    }

    this.pause();
    this._playbackSession += 1;

    var sessionId = this._playbackSession;
    var offsetMs = Math.max(0, Math.round(position * 1000 + this._scriptOffset));
    var playbackRate = getPlaybackRate();
    var plan = buildPlaybackPlan(this._actions, offsetMs);

    return this._ensureStreamingMode().then(function () {
      return _this._sendStream(plan.initialPosition, 1);
    }).catch(function () {
      return undefined;
    }).then(function () {
      plan.segments.forEach(function (segment) {
        var timerId = window.setTimeout(function () {
          if (sessionId !== _this._playbackSession || !_this._connected) {
            return;
          }

          _this._sendStream(segment.position, segment.duration / playbackRate).catch(function (_error) {
            _this.pause();
          });
        }, Math.max(0, Math.round(segment.delay / playbackRate)));

        _this._timers.push(timerId);
      });

      _this._playing = true;
    });
  };

  OssmInteractiveClient.prototype.pause = function () {
    this._playing = false;
    this._playbackSession += 1;
    clearTimers(this._timers);
    return Promise.resolve();
  };

  OssmInteractiveClient.prototype.ensurePlaying = function (position) {
    if (this._playing) {
      return Promise.resolve();
    }

    return this.play(position);
  };

  OssmInteractiveClient.prototype.setLooping = function (_looping) {
    return Promise.resolve();
  };

  function InteractiveMuxClient(options) {
    this._defaultClient = options.defaultClientProvider
      ? options.defaultClientProvider({
          handyKey: options.handyKey,
          scriptOffset: options.scriptOffset,
          stashConfig: options.stashConfig,
        })
      : null;
    this._ossmClient = new OssmInteractiveClient(options.scriptOffset);
  }

  InteractiveMuxClient.prototype._useOssm = function () {
    return getRuntimeSettings().enableOSSM === true;
  };

  InteractiveMuxClient.prototype._activeClient = function () {
    if (this._useOssm()) {
      return this._ossmClient;
    }

    return this._defaultClient;
  };

  Object.defineProperty(InteractiveMuxClient.prototype, "connected", {
    get: function () {
      var client = this._activeClient();
      return client ? client.connected : false;
    },
  });

  Object.defineProperty(InteractiveMuxClient.prototype, "playing", {
    get: function () {
      var client = this._activeClient();
      return client ? client.playing : false;
    },
  });

  Object.defineProperty(InteractiveMuxClient.prototype, "handyKey", {
    get: function () {
      var client = this._activeClient();
      return client && typeof client.handyKey === "string" ? client.handyKey : "";
    },
    set: function (key) {
      if (this._defaultClient) {
        this._defaultClient.handyKey = key;
      }
    },
  });

  InteractiveMuxClient.prototype.connect = function () {
    var client = this._activeClient();
    return client ? client.connect() : Promise.resolve();
  };

  InteractiveMuxClient.prototype.uploadScript = function (funscriptPath, apiKey) {
    var client = this._activeClient();
    return client ? client.uploadScript(funscriptPath, apiKey) : Promise.resolve();
  };

  InteractiveMuxClient.prototype.sync = function () {
    var client = this._activeClient();
    return client ? client.sync() : Promise.resolve(1);
  };

  InteractiveMuxClient.prototype.configure = function (config) {
    var tasks = [];

    if (this._defaultClient && typeof this._defaultClient.configure === "function") {
      tasks.push(this._defaultClient.configure(config));
    }

    tasks.push(this._ossmClient.configure(config));

    return Promise.allSettled(tasks).then(function () {
      return undefined;
    });
  };

  InteractiveMuxClient.prototype.play = function (position) {
    var client = this._activeClient();
    return client ? client.play(position) : Promise.resolve();
  };

  InteractiveMuxClient.prototype.pause = function () {
    var client = this._activeClient();
    return client ? client.pause() : Promise.resolve();
  };

  InteractiveMuxClient.prototype.ensurePlaying = function (position) {
    var client = this._activeClient();
    return client ? client.ensurePlaying(position) : Promise.resolve();
  };

  InteractiveMuxClient.prototype.setLooping = function (looping) {
    var client = this._activeClient();
    return client ? client.setLooping(looping) : Promise.resolve();
  };

  function OssmPluginSettingsExtension() {
    var settings = useSettings();
    var interactiveState = useInteractive();
    var pluginSettings = normaliseSettings((settings.plugins && settings.plugins[PLUGIN_ID]) || {});
    var serverOffset = interactiveState.serverOffset;
    var pendingConnectRef = React.useRef(false);

    React.useEffect(function () {
      persistSettings(pluginSettings);
    }, [pluginSettings.enableOSSM, pluginSettings.latencyCompensation, pluginSettings.deviceNamePrefix]);

    React.useEffect(function () {
      if (interactiveState.initialised) {
        pendingConnectRef.current = false;
      }
    }, [interactiveState.initialised]);

    React.useEffect(function () {
      if (
        !pendingConnectRef.current ||
        interactiveState.initialised ||
        !pluginSettings.enableOSSM ||
        !serverOffset ||
        interactiveState.state === ConnectionState.Connecting ||
        interactiveState.state === ConnectionState.Syncing
      ) {
        return;
      }

      interactiveState.initialise().finally(function () {
        pendingConnectRef.current = false;
      });
    }, [interactiveState, pluginSettings.enableOSSM, serverOffset]);

    function onConnect() {
      pendingConnectRef.current = true;
      interactiveState.initialise();
    }

    var message = null;
    var effectiveState = interactiveState.state;

    if (pluginSettings.enableOSSM && interactiveState.initialised && !interactiveState.interactive.connected) {
      effectiveState = ConnectionState.Disconnected;
    }

    if (!pluginSettings.enableOSSM) {
      message = "Enable OSSM playback above to activate this plugin in the current browser.";
    } else if (!isBluetoothSupported()) {
      message = "This browser does not support Web Bluetooth.";
    } else if (!isSecureBluetoothContext()) {
      message = "Open Stash on HTTPS or localhost before connecting to OSSM.";
    }

    return createElement(
      "div",
      { className: "plugin-settings" },
      createElement(
        "div",
        { className: "setting", id: "plugin-ossm-interactive-connect" },
        createElement(
          "div",
          null,
          createElement("h3", null, "OSSM connection"),
          createElement(
            "div",
            { className: "value" },
            stateLabel(effectiveState),
            interactiveState.error ? ": " + interactiveState.error : ""
          ),
          message ? createElement("div", { className: "value" }, message) : null
        ),
        createElement(
          "div",
          null,
          createElement(
            Button,
            {
              disabled:
                !pluginSettings.enableOSSM ||
                !isBluetoothSupported() ||
                !isSecureBluetoothContext() ||
                interactiveState.state === ConnectionState.Connecting ||
                interactiveState.state === ConnectionState.Syncing,
              onClick: onConnect,
            },
            interactiveState.initialised ? "Reconnect OSSM" : "Connect OSSM"
          )
        )
      )
    );
  }

  function OssmScenePlayerBridge() {
    var interactiveState = useInteractive();

    React.useEffect(function () {
      var attachedPlayer = null;
      var cleanup = function () {};

      function attachToPlayer() {
        var player = PluginApi.utils.InteractiveUtils.getPlayer();
        if (!player || player === attachedPlayer || typeof player.on !== "function") {
          return;
        }

        cleanup();
        attachedPlayer = player;

        function onSeeking() {
          if (!getRuntimeSettings().enableOSSM) {
            return;
          }

          interactiveState.interactive.pause();
        }

        function onSeeked() {
          if (!getRuntimeSettings().enableOSSM || !interactiveState.initialised) {
            return;
          }

          if (typeof player.paused === "function" && player.paused()) {
            interactiveState.interactive.pause();
            return;
          }

          interactiveState.interactive.play(player.currentTime());
        }

        function onRateChange() {
          if (!getRuntimeSettings().enableOSSM || !interactiveState.initialised) {
            return;
          }

          if (typeof player.paused === "function" && player.paused()) {
            return;
          }

          interactiveState.interactive.play(player.currentTime());
        }

        function onEnded() {
          if (!getRuntimeSettings().enableOSSM) {
            return;
          }

          interactiveState.interactive.pause();
        }

        player.on("seeking", onSeeking);
        player.on("seeked", onSeeked);
        player.on("ratechange", onRateChange);
        player.on("ended", onEnded);

        cleanup = function () {
          if (!player || typeof player.off !== "function") {
            return;
          }

          player.off("seeking", onSeeking);
          player.off("seeked", onSeeked);
          player.off("ratechange", onRateChange);
          player.off("ended", onEnded);
        };
      }

      attachToPlayer();
      var intervalId = window.setInterval(attachToPlayer, 500);

      return function () {
        window.clearInterval(intervalId);
        cleanup();
      };
    }, [interactiveState]);

    return null;
  }

  PluginApi.utils.InteractiveUtils.interactiveClientProvider = function (options) {
    return new InteractiveMuxClient(options);
  };

  PluginApi.patch.before("PluginRoutes", function (props) {
    return [
      {
        children: createElement(
          React.Fragment,
          null,
          createElement(OssmScenePlayerBridge, null),
          props.children
        ),
      },
    ];
  });

  PluginApi.patch.after("PluginSettings", function (props, rendered) {
    if (props.pluginID !== PLUGIN_ID) {
      return rendered;
    }

    return createElement(
      React.Fragment,
      null,
      rendered,
      createElement(OssmPluginSettingsExtension, null)
    );
  });
})();