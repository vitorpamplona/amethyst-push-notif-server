var admin = require("firebase-admin");

//path to the json you just downloaded
var serviceAccount = process.env.FIREBASE_CREDENTIAL ? 
  JSON.parse(
    Buffer.from(process.env.FIREBASE_CREDENTIAL, 'base64').toString('ascii')
  ) : require("../amethyst-firebase.json")

//init 
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

module.exports.admin = admin