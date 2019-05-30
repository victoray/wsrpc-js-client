class Deferred {
	constructor() {
		const self = this;

		self.resolve = null;
		self.reject = null;
		self.done = false;

		function wrapper(func) {
			return function () {
				if (self.done) throw new Error('Promise already done');
				self.done = true;
				return func.apply(this, arguments);
			}
		}

		self.promise = new Promise(
			(resolve, reject) => {
				self.resolve = wrapper(resolve);
				self.reject = wrapper(reject);
			}
		);

		self.promise.isPending = () => { return !self.done };
		return self;
	}
}

function logGroup(group, level, args) {
	console.group(group);
	console[level].apply(this, args);
	console.groupEnd();
}

function log() {
	if (!WSRPC.DEBUG) return;
	logGroup('WSRPC.DEBUG', 'trace', arguments);
}

function trace (msg) {
	if (!WSRPC.TRACE) return;

	var payload = msg;
	if ('data' in msg) payload = JSON.parse(msg.data);
	logGroup("WSRPC.TRACE", 'trace', [payload]);
}

function getAbsoluteWsUrl(url) {
	if ((/^\w+:\/\//).test(url)) return url;
	if (typeof window == 'undefined' && window.location.host.length < 1)
		throw new Error(
			`Can not construct absolute URL from ${window.location}`
		);
	const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
	const port = window.location.port === '' ? `:${window.location.port}` : '';
	const host = window.location.host;
	const path = url.replace(/^\/+/gm, '');
	return `${scheme}//${host}${port}/${path}`;
}

const readyState = Object.freeze({
	0: 'CONNECTING',
	1: 'OPEN',
	2: 'CLOSING',
	3: 'CLOSED'
});

class WSRPC {
	constructor (URL, reconnectTimeout = 1000) {
		var self = this;

		URL = getAbsoluteWsUrl(URL);

		self.id = 1;
		self.eventId = 0;
		self.socketStarted = false;
		self.eventStore = {
			onconnect: {},
			onerror: {},
			onclose: {},
			onchange: {}
		};
		self.connectionNumber = 0;
		self.oneTimeEventStore = {
			onconnect: [],
			onerror: [],
			onclose: [],
			onchange: []
		};

		self.callQueue = [];

		function createSocket() {
			var ws = new WebSocket(URL);

			var rejectQueue = function () {
				self.connectionNumber++; // rejects incoming calls
				var deferred;

				//reject all pending calls
				while (0 < self.callQueue.length) {
					var callObj = self.callQueue.shift();
					deferred = self.store[callObj.id];
					delete self.store[callObj.id];

					if (deferred && deferred.promise.isPending()) {
						deferred.reject('WebSocket error occurred');
					}
				}

				// reject all from the store
				for (var key in self.store) {
					if (!self.store.hasOwnProperty(key)) continue;

					deferred = self.store[key];
					if (deferred && deferred.promise.isPending()) {
						deferred.reject('WebSocket error occurred');
					}
				}
			};

			function reconnect(callEvents) {
				setTimeout(function () {
					try {
						self.socket = createSocket();
						self.id = 1;
					} catch (exc) {
						callEvents('onerror', exc);
						delete self.socket;
						console.error(exc);
					}
				}, reconnectTimeout);
			}

			ws.onclose = function (err) {
				log('ONCLOSE CALLED', 'STATE', self.public.state());
				trace(err);

				for (var serial in self.store) {
					if (!self.store.hasOwnProperty(serial)) continue;
					if (self.store[serial].hasOwnProperty('reject')) {
						self.store[serial].reject('Connection closed');
					}
				}

				rejectQueue();
				callEvents('onclose', err);
				callEvents('onchange', err);
				reconnect(callEvents);
			};

			ws.onerror = function (err) {
				log('ONERROR CALLED', 'STATE', self.public.state());
				trace(err);

				rejectQueue();
				callEvents('onerror', err);
				callEvents('onchange', err);

				log('WebSocket has been closed by error: ', err);
			};

			function tryCallEvent(func, event) {
				try {
					return func(event);
				} catch (e) {
					if (e.hasOwnProperty('stack')) {
						log(e.stack);
					} else {
						log('Event function', func, 'raised unknown error:', e);
					}
					console.error(e);
				}
			}

			function callEvents(evName, event) {
				while (0 < self.oneTimeEventStore[evName].length) {
					var deferred = self.oneTimeEventStore[evName].shift();
					if (deferred.hasOwnProperty('resolve') &&
						deferred.promise.isPending()) deferred.resolve();
				}

				for (var i in self.eventStore[evName]) {
					if (!self.eventStore[evName].hasOwnProperty(i)) continue;
					var cur = self.eventStore[evName][i];
					tryCallEvent(cur, event);
				}
			}

			ws.onopen = function (ev) {
				log('ONOPEN CALLED', 'STATE', self.public.state());
				trace(ev);

				while (0 < self.callQueue.length) {
					// noinspection JSUnresolvedFunction
					self.socket.send(JSON.stringify(self.callQueue.shift(), 0, 1));
				}

				callEvents('onconnect', ev);
				callEvents('onchange', ev);
			};

			function handleCall(self, data) {
				if (!self.routes.hasOwnProperty(data.method))
					throw new Error('Route not found');

				var connectionNumber = self.connectionNumber;
				var deferred = new Deferred();

				deferred.promise.then(
					function (result) {
						if (connectionNumber !== self.connectionNumber) return;
						self.socket.send(JSON.stringify({
							id: data.id,
							result: result
						}));
					},
					function (error) {
						if (connectionNumber !== self.connectionNumber) return;
						self.socket.send(JSON.stringify({
							id: data.id,
							error: error
						}));
					}
				);

				var func = self.routes[data.method];

				if (self.asyncRoutes[data.method])
					return func.apply(deferred, [data.params]);

				function badPromise() {
					throw new Error(
						"You should register route with async flag."
					);
				}

				var promiseMock = {
					resolve: badPromise,
					reject: badPromise,
				};

				try {
					deferred.resolve(func.apply(promiseMock, [data.params]));
				} catch (e) {
					deferred.reject(e);
					console.error(e);
				}
			}

			function handleError(self, data) {
				if (!self.store.hasOwnProperty(data.id))
					return log('Unknown callback');

				var deferred = self.store[data.id];

				if (typeof deferred === 'undefined')
					return log('Confirmation without handler');

				delete self.store[data.id];
				log('REJECTING', data.error);
				deferred.reject(data.error);
			}

			function handleResult(self, data) {
				var deferred = self.store[data.id];
				if (typeof deferred === 'undefined')
					return log('Confirmation without handler');

				delete self.store[data.id];

				if (data.hasOwnProperty('result')) {
					return deferred.resolve(data.result);
				}
				return deferred.reject(data.error);
			}

			ws.onmessage = function (message) {
				log('ONMESSAGE CALLED', 'STATE', self.public.state());
				trace(message);

				if (message.type !== 'message') return;

				var data;

				try {
					data = JSON.parse(message.data);
					log(data);

					if (!data.hasOwnProperty('id')) {
						var current;

						console.group("Event received");
						for (var i = 0; i < self.socketEventsListeners.length; i++) {
							try {
								current = self.socketEventsListeners[i];
								current.apply(self.public, [data]);
							} catch (e) {
								console.error(e);
							}
						}
						console.groupEnd();
					} else if (data.hasOwnProperty('method')) {
						return handleCall(self, data);
					} else if (data.hasOwnProperty('error') && data.error === null) {
						return handleError(self, data);
					} else {
						return handleResult(self, data);
					}
				} catch (exception) {
					var err = {
						error: exception.message,
						result: null,
						id: data ? data.id : null
					};

					self.socket.send(JSON.stringify(err));
					console.error(exception);
				}
			};

			return ws;
		}

		function makeCall(func, args, params) {
			self.id += 2;
			var deferred = new Deferred();

			var callObj = Object.freeze({
				id: self.id,
				method: func,
				params: args
			});

			var state = self.public.state();

			if (state === 'OPEN') {
				self.store[self.id] = deferred;
				self.socket.send(JSON.stringify(callObj));
			} else if (state === 'CONNECTING') {
				log('SOCKET IS', state);
				self.store[self.id] = deferred;
				self.callQueue.push(callObj);
			} else {
				log('SOCKET IS', state);
				if (params && params['noWait']) {
					deferred.reject(`Socket is: ${state}`);
				} else {
					self.store[self.id] = deferred;
					self.callQueue.push(callObj);
				}
			}

			return deferred.promise;
		}

		self.socketEventsListeners = [function (event) {console.log(event);}];
		self.asyncRoutes = {};
		self.routes = {};
		self.store = {};
		self.public = Object.freeze({
			call: function (func, args, params) {
				return makeCall(func, args, params);
			},
			addRoute: function (route, callback, isAsync) {
				self.asyncRoutes[route] = isAsync || false;
				self.routes[route] = callback;
			},
			deleteRoute: function (route) {
				delete self.asyncRoutes[route];
				return delete self.routes[route];
			},
			addEventListener: function (event, func) {
				var eventId = self.eventId++;
				self.eventStore[event][eventId] = func;
				return eventId;
			},
			removeEventListener: function (event, index) {
				if (self.eventStore[event].hasOwnProperty(index)) {
					delete self.eventStore[event][index];
					return true;
				} else {
					return false;
				}
			},
			onEvent: function (event) {
				var deferred = new Deferred();
				self.oneTimeEventStore[event].push(deferred);
				return deferred.promise;
			},
			destroy: function () {
				return self.socket.close();
			},
			state: function () {
				return readyState[this.stateCode()];
			},
			stateCode: function () {
				if (self.socketStarted && self.socket)
					return self.socket.readyState;
				return 3;
			},
			connect: function () {
				self.socketStarted = true;
				self.socket = createSocket();
			},
			addServerEventListener: function (callable) {
				return self.socketEventsListeners.push(callable) - 1;
			},
			removeServerEventListener: function (index) {
			    return self.socketEventsListeners.splice(index, 1).length;
			}
		});

		self.public.addRoute('log', function (argsObj) {
			console.info(`Websocket sent: ${argsObj}`);
		});

		self.public.addRoute('ping', function (data) {
			return data;
		});

		return self.public;
	}
}

WSRPC.DEBUG = false;
WSRPC.TRACE = false;

export default WSRPC;
