import express from 'express'
import bodyparser from 'body-parser'
import { admin } from './firebase-config.js'
import { nip44 } from '@nostr/tools'
import { finalizeEvent, generateSecretKey, verifyEvent } from '@nostr/tools/pure'
import { RelayPool } from './relay-pool.js'
import { LRUCache } from 'lru-cache'

import { 
    registerInDatabaseTuples, 
    getAllKeys, 
    getAllRelays, 
    getTokensByPubKey, 
    deleteToken,
    deleteRelay,
    checkIfThereIsANewRelay
} from './database.mjs'

const app = express()
app.use(bodyparser.json())

const port = process.env.PORT || 3000

var relayPool;

const relayReliability = new Map();

const sentCache = new LRUCache(
    {
        max: 5000,
        maxSize: 5000,
        sizeCalculation: (value, key) => {
            return 1
        },
        // how long to live in ms
        ttl: 1000 * 60 * 5,
    }
)

app.post('/register', (req, res) => {
    register(req.body.events).then((processed) => {
        res.status(200).send(processed)
    });
})

app.listen(port, () => {
    console.log("Listening to port" + port)
})

function isValidUrl(urlString) {
    try { 
        return Boolean(new URL(urlString)); 
    }
    catch(e){ 
        return false; 
    }
}

function isSupportedUrl(url) {
    return url &&
        !url.includes("brb.io") && // no broken relayss
        !url.includes("echo.websocket.org") && // test relay
        !url.includes("127.0") && // no local relays
        !url.includes("umbrel.local") && // no local relays
        !url.includes("192.168.") && // no local relays
        !url.includes(".onion") && // we are not running on Tor
        !url.includes("https://") && // not a websocket
        !url.includes("http://") && // not a websocket
        !url.includes("www://") && // not a websocket
        !url.includes("https//") && // not a websocket
        !url.includes("http//") && // not a websocket
        !url.includes("www//") && // not a websocket
        !url.includes("npub1") && // does not allow custom uris
        !url.includes("was://") &&  // common mispellings
        !url.includes("ws://umbrel:") &&  // local domain
        !url.includes("\t") &&  // tab is not allowed
        !url.includes(" ") && // space is not allowed
        isValidUrl(url)
}

// -- registering tokens with pubkeys. 

async function register(events) {
    let processed = []

    //let newPubKeys = false
    let newRelays = false

    for (const event of events) {
        let veryOk = verifyEvent(event)
        
        let tokenTag = event.tags
            .find(tag => tag[0] == "challenge" && tag.length > 1)

        let relayTags = event.tags
            .filter(tag => tag[0] == "relay" && tag.length > 1 && tag[1].length > 1 && isSupportedUrl(tag[1]))
            .map(tag => tag[1])
            .filter(function (value, index, array) { 
              // remove duplicates 
              return array.indexOf(value) === index;
            })

        if (tokenTag[1] && veryOk && relayTags.length > 0) {
            newRelays = await checkIfThereIsANewRelay(relayTags)

            await registerInDatabaseTuples(relayTags.map(relayUrl => [event.pubkey,relayUrl || null,tokenTag[1]]))
        } else {
            console.log("Invalid registration", veryOk, tokenTag, event.tags)
        }

        processed.push(
            {
                "pubkey": event.pubkey,
                "added": tokenTag && veryOk && relayTags.length > 0
            }
        )
    }

    if (newRelays)
        restartRelayPool()

    return processed
}

// -- notifiying new events to pub keys. 

async function notify(event, relay) {
    let pubkeyTag = event.tags.find(tag => tag[0] == "p" && tag.length > 1)
    if (pubkeyTag && pubkeyTag[1]) {
        //console.log("New kind", event.kind, "event for", pubkeyTag[1], "from", relay.url)

        let tokens = await getTokensByPubKey(pubkeyTag[1])
        let tokensAsUrls = tokens.filter(isValidHttpUrl)
        let firebaseTokens = tokens.filter(item => !tokensAsUrls.includes(item))

        if (tokens.length > 0) {
            const stringifiedWrappedEventToPush = JSON.stringify(createWrap(pubkeyTag[1], event))

            if (tokensAsUrls.length > 0) {      
                if (stringifiedWrappedEventToPush.length > 4000) {
                    // too big, send a wake up.
                    const wakeUpEvent = createWakeUpEvent(event, relay.url)
                    const stringifiedWrappedEventToPush2 = JSON.stringify(createWrap(pubkeyTag[1], wakeUpEvent))

                    tokensAsUrls.forEach(async function (tokenUrl) {
                        fetch(tokenUrl, {
                            method: 'POST',
                            body: stringifiedWrappedEventToPush2,
                            signal: AbortSignal.timeout(5000) // NTFY waits for 30 seconds to send a timeout when the user sent too many reqs
                        }).then((response) => {
                            if (!response.ok) {
                                let after = response.headers.get('Retry-After');
                                console.log("Error posting to NTFY", stringifiedWrappedEventToPush2.length, "chars.", tokenUrl, response.status, response.statusText, "retry after", after)
                                if (response.status != 429) {
                                    deleteToken(tokenUrl)
                                }
                            }
                        }).catch(err => {
                            console.log("Error posting to NTFY", stringifiedWrappedEventToPush2.length, "chars.", tokenUrl, err)
                            //deleteToken(tokenUrl)
                        })
                    });
                    console.log("NTFY Wake kind", event.kind, "event for", pubkeyTag[1], "with", stringifiedWrappedEventToPush2.length, "bytes")
                } else {
                    tokensAsUrls.forEach(async function (tokenUrl) {
                        fetch(tokenUrl, {
                            method: 'POST',
                            body: stringifiedWrappedEventToPush,
                            signal: AbortSignal.timeout(5000) // NTFY waits for 30 seconds to send a timeout when the user sent too many reqs
                        }).then((response) => {
                            if (!response.ok) {
                                let after = response.headers.get('Retry-After');
                                console.log("Error posting to NTFY", stringifiedWrappedEventToPush.length, "chars.", tokenUrl, response.status, response.statusText, "retry after", after)
                                if (response.status != 429) {
                                    deleteToken(tokenUrl)
                                }
                            }
                        }).catch(err => {
                            console.log("Error posting to NTFY", stringifiedWrappedEventToPush.length, "chars.", tokenUrl, err)
                            //deleteToken(tokenUrl)
                        })
                    });
                    console.log("NTFY New kind", event.kind, "event for", pubkeyTag[1], "with", stringifiedWrappedEventToPush.length, "bytes")
                }
            }

            if (firebaseTokens.length > 0) {
                if (stringifiedWrappedEventToPush.length > 4000) {
                    // too big, send a wake up.
                    const wakeUpEvent = createWakeUpEvent(event, relay.url)
                    const stringifiedWrappedEventToPush2 = JSON.stringify(createWrap(pubkeyTag[1], wakeUpEvent))

                    const message = {
                        data: {
                            encryptedEvent: stringifiedWrappedEventToPush2
                        },
                        tokens: firebaseTokens
                    };
        
                    admin.messaging().sendEachForMulticast(message).then((response) => {
                        if (response.failureCount > 0) {
                            response.responses.forEach((resp, idx) => {
                                if (!resp.success) {
                                    console.log('Failed: ', resp.error.code, resp.error.message, JSON.stringify(message).length, "chars");
                                    if (resp.error.code === "messaging/registration-token-not-registered") {
                                        console.log('Deleting Token ', tokens[idx]);
                                        deleteToken(tokens[idx])
                                    }
                                }
                            });
                        } 
                    });   
                    
                    console.log("Firebase Wake kind", event.kind, "event for", pubkeyTag[1], "with", stringifiedWrappedEventToPush2.length, "bytes")
                } else {
                    const message = {
                        data: {
                            encryptedEvent: stringifiedWrappedEventToPush
                        },
                        tokens: firebaseTokens
                    };
        
                    admin.messaging().sendEachForMulticast(message).then((response) => {
                        if (response.failureCount > 0) {
                            response.responses.forEach((resp, idx) => {
                                if (!resp.success) {
                                    console.log('Failed: ', resp.error.code, resp.error.message, JSON.stringify(message).length, "chars");
                                    if (resp.error.code === "messaging/registration-token-not-registered") {
                                        console.log('Deleting Token ', tokens[idx]);
                                        deleteToken(tokens[idx])
                                    }
                                }
                            });
                        } 
                    });   
                    
                    console.log("Firebase New kind", event.kind, "event for", pubkeyTag[1], "with", stringifiedWrappedEventToPush.length, "bytes")
                }
                
            }
        }
    }
}

function isValidHttpUrl(string) {
    let givenURL;

    try {
        givenURL = new URL(string);
    } catch (error) {
      //console.log("error is",error)
        return false;  
    }
    return givenURL.protocol === "http:" || givenURL.protocol === "https:";
  }

var isInRelayPollFunction = false

// -- relay connection
async function restartRelayPool() {
    if (isInRelayPollFunction) return 
    isInRelayPollFunction = true

    let relays = await getAllRelays()

    if (relayPool) {
        let hasNewRelay = relays.filter(x => !relayPool.has(x)).length > 0

        if (!hasNewRelay) return
    }

    if (relayPool) {
        relayPool.close()
    }

    relayPool = RelayPool( Array.from( relays ), {reconnect: true} )

    relayPool.on('open', relay => {
        relayReliability.set(relay.url, 0);
        const nowUnix = Math.floor(Date.now() / 1000)
        relay.subscribe("realtime", 
            {
                kinds: [4, 9735, 21059],
                limit: 1,
                since: nowUnix - 100
            }
        )
        relay.subscribe("delayed", 
            {
                kinds: [1059],
                limit: 1,
                since: nowUnix - 172800
            }
        )
    });
    
    relayPool.on('eose', relay => {
        relay.isLive = true
        //console.log("EOSE")
        relayReliability.set(relay.url, 0);
    });
    
    relayPool.on('event', (relay, sub_id, ev) => {
        if (relay.isLive) {
            try {
                if (sentCache.has(ev.id)) return

                const nowUnix = Math.floor(Date.now() / 1000)
                if (
                    ((ev.kind == 4 || ev.kind == 9735 || ev.kind == 21059) && ev.created_at > nowUnix - 100) ||
                    (ev.kind == 1059 && ev.created_at > nowUnix - 172800)
                ) {
                    sentCache.set(ev.id, ev.id)

                    notify(ev, relay)
                } else {
                    console.log("Outside", relay.url, ev.kind, ev.created_at, nowUnix)
                }       
            } catch (e) {
                console.log(relay.url, ev, e)
            }
        }
    });

    relayPool.on('error', (relay, e) => {
        if (
            !isSupportedUrl(relay.url)
            || e.message.includes("Invalid URL")
            || e.message.includes("ECONNREFUSED")
            || e.message.includes("Invalid WebSocket frame: FIN must be set")
            || e.message.includes("The URL's protocol must be one of")
        ) {
            console.log("Can't connect, deleting relay ", relay.url)
            relayPool.remove(relay.url)
            deleteRelay(relay.url)
            relayReliability.set(relay.url, 0);
        } 

        const current = relayReliability.get(relay.url) || 0

        relayReliability.set(relay.url, current + 1);

        if (relayReliability.get(relay.url) > 10) {
            console.log("Error ", relay.url, current)
        }

        if (relayReliability.get(relay.url) > 25) {
            console.log("25 failures, deleting relay ", relay.url)
            relayPool.remove(relay.url)
            deleteRelay(relay.url)
            relayReliability.set(relay.url, 0);
        }

		// console.log("Error", relay.url, e.message)
	})

    console.log("Restarted pool with", relays.length, "relays")
    isInRelayPollFunction = false
}

function createWrap(recipientPubkey, event, tags = []) {
    const wrapperPrivkey = generateSecretKey()
  
    const wrapTemplate = {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: tags,
      content: nip44.encrypt(
        JSON.stringify(event), 
        nip44.getConversationKey(wrapperPrivkey, recipientPubkey)
      )
    } 

    return finalizeEvent(wrapTemplate, wrapperPrivkey)
  }

function createWakeUpEvent(event, relayUrl) {
    const wrapperPrivkey = generateSecretKey()
    const now = Math.floor(Date.now() / 1000)
  
    const wakeUpEventTemplate = {
        kind: 23903,
        created_at: now,
        tags: [
            ["e", event.id, relayUrl],
            ["k", event.kind],
            ["p", event.pubkey]
        ],
        content: ""
    } 

    return finalizeEvent(wakeUpEventTemplate, wrapperPrivkey)
  }  

restartRelayPool()