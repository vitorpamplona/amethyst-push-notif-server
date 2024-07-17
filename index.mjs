import express from 'express'
import bodyparser from 'body-parser'
import { admin } from './firebase-config.js'
import { nip44 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import { RelayPool } from './relay-pool.js'
import { LRUCache } from 'lru-cache'
import ntfyPublish, { DEFAULT_PRIORITY } from '@cityssm/ntfy-publish'

import { 
    registerInDatabase, 
    getAllKeys, 
    getAllRelays, 
    getTokensByPubKey, 
    deleteToken,
    deleteRelay,
    checkIfPubKeyExists, 
    checkIfRelayExists 
} from './database.mjs'

const app = express()
app.use(bodyparser.json())

const port = process.env.PORT || 3000

var relayPool;

const sentCache = new LRUCache(
    {
        max: 500,
        maxSize: 5000,
        sizeCalculation: (value, key) => {
            return 1
        },
        // how long to live in ms
        ttl: 1000 * 60 * 5,
    }
)

app.post('/register', (req, res) => {
    const token = req.body.token
    const events = req.body.events

    register(token, events).then((processed) => {
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
    return url && !url.includes("brb.io") // no broken relays
    && !url.includes("127.0") // no local relays
    && !url.includes("umbrel.local") // no local relays
    && !url.includes("192.168.") // no local relays
    && !url.includes(".onion") // we are not running on Tor
    && !url.includes("https://") // not a websocket
    && !url.includes("http://") // not a websocket
    && !url.includes("npub1") // does not allow custom uris
    && isValidUrl(url)
}

// -- registering tokens with pubkeys. 

async function register(token, events) {
    let processed = []

    let newPubKeys = false
    let newRelays = false

    for (const event of events) {
        let veryOk = verifyEvent(event)
        
        let tokenTag = event.tags
            .find(tag => tag[0] == "challenge" && tag.length > 1)

        let relayTag = event.tags
            .find(tag => tag[0] == "relay" && tag.length > 1)

        let veryUrl = relayTag[1] && isSupportedUrl(relayTag[1])

        if (veryUrl && tokenTag[1] && veryOk) {
            let keyExist = await checkIfPubKeyExists(event.pubkey)

            if (!keyExist) {
                newPubKeys = true
            }

            let relayExist = await checkIfRelayExists(relayTag[1])

            if (!relayExist) {
                newRelays = true
            }

            await registerInDatabase(event.pubkey,relayTag[1],tokenTag[1])
        } else {
            console.log("Invalid registration", veryOk, veryUrl, tokenTag, relayTag)
        }

        processed.push(
            {
                "pubkey": event.pubkey,
                "added": veryUrl && tokenTag && veryOk
            }
        )
    }

    if (newRelays)
        restartRelayPool()
    else if (newPubKeys) {
        restartRelaySubs()
    } 

    return processed
}

// -- notifiying new events to pub keys. 

async function notify(event, relay) {
    let pubkeyTag = event.tags.find(tag => tag[0] == "p" && tag.length > 1)
    if (pubkeyTag && pubkeyTag[1]) {
        //console.log("New kind", event.kind, "event for", pubkeyTag[1])

        let tokens = await getTokensByPubKey(pubkeyTag[1])
        let tokensAsUrls = tokens.filter(isValidHttpUrl)
        let firebaseTokens = tokens.filter(item => !tokensAsUrls.includes(item))

        if (tokens.length > 0) {
            const stringifiedWrappedEventToPush = JSON.stringify(createWrap(pubkeyTag[1], event))

            if (tokensAsUrls.length > 0) {                
                tokensAsUrls.forEach(async function (tokenUrl) {
                    const urlWithTopic = new URL(tokenUrl)
                    const currentServer = urlWithTopic.origin
                    const currentTopic = urlWithTopic.pathname.substring(1)

                    try {
                        await ntfyPublish({
                            server: currentServer,
                            topic: currentTopic,
                            message: stringifiedWrappedEventToPush
                        })
                    } catch(e) {
                        deleteToken(tokenUrl)
                    }
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

    if (relayPool) {
        relayPool.close()
    }

    let relays = await getAllRelays()
    let keys = await getAllKeys()

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
        if (sentCache.has(ev.id)) return
        sentCache.set(ev.id, ev.id)

        notify(ev, relay)
    });

    relayPool.on('error', (relay, e) => {
        if (
            !isSupportedUrl(relay.url)
            || e.message.includes("Invalid URL")
            || e.message.includes("ECONNREFUSED")
            || e.message.includes("Invalid WebSocket frame: FIN must be set")
            || e.message.includes("The URL's protocol must be one of")
        ) {
            deleteRelay(relay.url)
        } 

		console.log("Error", relay.url, e.message)
	})

    console.log("Restarted pool with", relays.length, "relays and", keys.length, "keys")
    isInRelayPollFunction = false
}

var isInSubRestartFunction = false

async function restartRelaySubs() {
    if (isInSubRestartFunction) return 
    isInSubRestartFunction = true

    let keys = await getAllKeys()

    relayPool.subscribe("subid", 
        {
            kinds: [4, 9735, 1059],
            limit: 1
        }
    );

    console.log("Restarted subs with", keys.length, "keys")
    isInSubRestartFunction = false
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