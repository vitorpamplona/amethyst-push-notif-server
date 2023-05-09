import express from 'express'
import bodyparser from 'body-parser'
import { admin } from './firebase-config.js'
import {SimplePool} from 'nostr-tools'
import { verifySignature } from 'nostr-tools'

const app = express()
app.use(bodyparser.json())

const port = 3000

const db = new Map();

app.post('/register', (req, res) => {
    const token = req.body.token
    const event = req.body.event

    let veryOk = verifySignature(event)

    console.log(veryOk)

    if (veryOk) {
        if (db.has[event.pubkey])
            db.set(event.pubkey, db.get[event.pubkey].push(token))
        else
        db.set(event.pubkey, [token])
        res.status(200).send("Registration Successful")
    } else
        res.status(403).send("Couldnot verify event")
})

function send(event) {
    const message = {
        data: event,
        tokens: db[event.pubkey]
    };

    admin.messaging().send(message)
}

app.listen(port, () => {
    console.log("listening to port" + port)
})

// -- relay connection

const pool = new SimplePool()

let relays = ['wss://nos.lol', 'wss://nostr.mom']

let sub = pool.sub(
    relays,
    [
        {
            "p": [ db.entries ]
        }
    ]
)

sub.on('event', event => {
    notify(event)
})