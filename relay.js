const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

Relay.prototype.wait_connected = async function relay_wait_connected(data) {
	let retry = 100000
	while (true) {
		if (!this.manualClose && this.ws && this.ws.readyState !== 1) {
			await sleep(retry)
			retry *= 1.5
		}
		else {
			return
		}
	}
}


function Relay(relay, opts={})
{
	if (!(this instanceof Relay))
		return new Relay(relay, opts)

	this.url = relay
	this.opts = opts

	if (opts.reconnect == null)
		opts.reconnect = true

	const me = this
	me.onfn = {}

	init_websocket(me)
		.catch(e => {
			if (me.onfn.error)
				me.onfn.error(e)
		})

	return this
}

function init_websocket(me) {
	return new Promise((resolve, reject) => {
		const ws = me.ws = new WS(me.url, undefined, {
			followRedirects: true,
			headers: {
			  "User-Agent": "Amethyst Push Server"
			}
		});

		let resolved = false
		ws.onmessage = (m) => {
			handle_nostr_message(me, m)
			if (me.onfn.message)
				me.onfn.message(m)
		}
		ws.onclose = (e) => {
			if (me.onfn.close)
				me.onfn.close(e)
			if (me.reconnecting)
				return reject(new Error("close during reconnect"))
			if (!me.manualClose && me.opts.reconnect)
				reconnect(me)
		}
		ws.onerror = (e) => {
			if (me.onfn.error)
				me.onfn.error(e)
			if (me.reconnecting)
				return reject(new Error("error during reconnect"))
			if (!me.manualClose && me.opts.reconnect)
				reconnect(me)
		}
		ws.onopen = (e) => {
			if (me.onfn.open)
				me.onfn.open(e)

			if (resolved) return

			resolved = true
			resolve(me)
		}
	});
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function reconnect(me)
{
	const reconnecting = true
	let n = 100
	try {
		me.reconnecting = true
		await init_websocket(me)
		me.reconnecting = false
	} catch {
		//console.error(`error thrown during reconnect... trying again in ${n} ms`)
		await sleep(n)
		n *= 1.5
	}
}

Relay.prototype.on = function relayOn(method, fn) {
	this.onfn[method] = fn
	return this
}

Relay.prototype.close = function relayClose() {
	this.manualClose = true
	if (this.ws) {
		this.ws.close()
	}
}

Relay.prototype.subscribe = function relay_subscribe(sub_id, filters) {
	if (Array.isArray(filters))
		this.send(["REQ", sub_id, ...filters])
	else
		this.send(["REQ", sub_id, filters])
}

Relay.prototype.unsubscribe = function relay_unsubscribe(sub_id) {
	this.send(["CLOSE", sub_id])
}

Relay.prototype.send = async function relay_send(data) {
	await this.wait_connected()
	if (!this.manualClose && this.ws && this.ws.readyState == 1) {
		this.ws.send(JSON.stringify(data))
	} else {
		console.log("WS not found while sending to ", this.url)
	}
}

function handle_nostr_message(relay, msg)
{
	let data
	try {
		data = JSON.parse(msg.data)
	} catch (e) {
		console.error("handle_nostr_message", relay.url, msg.data, e)
		return
	}
	if (data.length >= 2) {
		switch (data[0]) {
		case "EVENT":
			if (data.length < 3)
				return
			return relay.onfn.event && relay.onfn.event(data[1], data[2])
		case "EOSE":
			return relay.onfn.eose && relay.onfn.eose(data[1])
		case "NOTICE":
			return relay.onfn.notice && relay.onfn.notice(...data.slice(1))
		case "OK":
			return relay.onfn.ok && relay.onfn.ok(...data.slice(1))
		}
	}
}

module.exports = Relay
