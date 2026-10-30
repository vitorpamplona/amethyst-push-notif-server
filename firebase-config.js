const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

//path to the json you just downloaded
var serviceAccount = process.env.FIREBASE_CREDENTIAL ? 
  JSON.parse(
    Buffer.from(process.env.FIREBASE_CREDENTIAL, 'base64').toString('ascii')
  ) : require("../amethyst-firebase.json")

//init 
const app = initializeApp({
  credential: cert(serviceAccount),
})

module.exports.messaging = getMessaging(app)
