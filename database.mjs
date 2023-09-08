import { pgPool } from './database-config.mjs'

export async function getTokensByPubKey(pubkey) {
    const result = await pgPool.query(
        `SELECT DISTINCT TOKEN AS token, MAX(ID) as max_id
         FROM subscriptions
         WHERE PUB_KEY = $1
         GROUP BY TOKEN
         ORDER BY max_id DESC
         LIMIT 5`,
        [pubkey]
    );

    if (!result || !result.rows || !result.rows.length) return [];

    let tokens = []
    for (let row of result.rows) {
        tokens.push(row.token)
    }
    return tokens
}

export async function getAllKeys() {
    const result = await pgPool.query(
        `SELECT DISTINCT PUB_KEY AS key
         FROM subscriptions
        `
    )
    if (!result || !result.rows || !result.rows.length) return [];

    let keys = []
    for (let row of result.rows) {
        keys.push(row.key)
    }
    return keys
}

export async function getAllRelays() {
    const result = await pgPool.query(
        `SELECT rtrim(RELAY,'/') AS relay, COUNT(*) AS votes
        FROM subscriptions 
        group by relay
        order by votes desc
        `
    )

    if (!result || !result.rows || !result.rows.length) return [];

    let relays = []
    for (let row of result.rows) {
        if (
            !row.relay.includes("127.0.0.") 
            && !row.relay.includes("//umbrel:")
            && !row.relay.includes("wss://wss:")
            && !row.relay.includes("weixin")
            && !row.relay.includes("brb.io") // too many bugs
        ) {
            if (row.votes > 2) {
                relays.push(row.relay)
            }
        }
    }
    return relays
}

export async function registerInDatabase(pubkey, relay, token) {
    pgPool.query(
        `INSERT INTO subscriptions (PUB_KEY, RELAY, TOKEN) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (PUB_KEY, RELAY, TOKEN) 
         DO NOTHING;
        `,
        [pubkey, relay || null, token],
        (err, res) => {
            if (err) {
                console.log("Database Insert: " + err)
            }
        }
      )
}

export async function deleteToken(token) {
    pgPool.query(
        `DELETE from subscriptions 
         WHERE TOKEN = $1
        `,
        [token],
        (err, res) => {
            if (err) {
                console.log("Database Insert: " + err)
            }
            if (res) {
                console.log("Token Deleted: " + token)
            }
        }
      )
}


export async function checkIfPubKeyExists(pubkey) {
    const result = await pgPool.query(
        `SELECT COUNT(*) AS instances
         FROM subscriptions
         WHERE PUB_KEY = $1
        `,
        [pubkey]
    );

    if (!result || !result.rows || !result.rows.length) return [];
    return result.rows[0].instances && result.rows[0].instances > 0
}

export async function checkIfRelayExists(relay) {
    const result = await pgPool.query(
        `SELECT COUNT(*) AS instances
         FROM subscriptions
         WHERE RELAY = $1
        `,
        [relay]
    );

    if (!result || !result.rows || !result.rows.length) return [];
    return result.rows[0].instances && result.rows[0].instances > 0
}