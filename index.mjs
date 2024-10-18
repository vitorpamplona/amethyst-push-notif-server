import express from 'express'
import bodyparser from 'body-parser'
import { admin } from './firebase-config.js'
import { nip44 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure'
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
    register(req.body.token, req.body.events).then((processed) => {
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
        !url.includes("brb.io") && // no broken relays
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

async function register(token, events) {
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
            console.log("Invalid registration", veryOk, tokenTag, relayTags)
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
                tokensAsUrls.forEach(async function (tokenUrl) {
                    fetch(tokenUrl, {
                        method: 'POST',
                        body: stringifiedWrappedEventToPush,
                        signal: AbortSignal.timeout(5000) // NTFY waits for 30 seconds to send a timeout when the user sent too many reqs
                    }).then((response) => {
                        if (!response.ok) {
                            console.log("Error posting to NTFY", stringifiedWrappedEventToPush.length, "chars.", tokenUrl, response.status, response.statusText)
                            deleteToken(tokenUrl)
                        }
                    }).catch(err => {
                        console.log("Error posting to NTFY", stringifiedWrappedEventToPush.length, "chars.", tokenUrl, err)
                        //deleteToken(tokenUrl)
                    })
                });
                console.log("NTFY New kind", event.kind, "event for", pubkeyTag[1], "with", stringifiedWrappedEventToPush.length, "bytes")
            }

            if (firebaseTokens.length > 0) {
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
        relay.subscribe("subid", 
            {
                kinds: [4, 9735, 1059],
                limit: 1
            }
        )
    });
    
    relayPool.on('eose', relay => {
        //console.log("EOSE")
    });
    
    relayPool.on('event', (relay, sub_id, ev) => {
        try {
            if (sentCache.has(ev.id)) return
            sentCache.set(ev.id, ev.id)
    
            notify(ev, relay)
        } catch (e) {
            console.log(relay, ev, e)
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
            relayPool.remove(relay.url)
            deleteRelay(relay.url)
        } 

		//console.log("Error", relay.url, e.message)
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

restartRelayPool()