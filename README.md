# amethyst-push-notif-server
A simple push notification server for Nostr events. 

# Deployment Overview

This repo is setup to be automatically deployed to Heroku

## 1. Create a service key from firebase

Go to Firebase, services and download the service credentials.

Convert it to a Base64 representation: 

```
openssl base64 -in ../amethyst-firebase.json -out firebaseConfigBase64.txt  
```


## 2. Connect this GitHub repo to Heroku

## 3. On Heroku, update the ENV variables to use the base64 Representation

```
FIREBASE_CREDENTIAL = BASE64DATA
```

# Development Overview

This is a NodeJS + Express app. 

## Running

Install modules:
`npm install`

To run, do:
`node index.mjs`

## Generating new Version

GitHub Actions generates a new [Release](https://github.com/vitorpamplona/amethyst-push-notif-server/releases) when npm version is run and pushed to the repo.

```
npm version <version number: x.x.x>
```

## Contributing

[Issues](https://github.com/vitorpamplona/amethyst-push-notif-server/issues) and [pull requests](https://github.com/vitorpamplona/amethyst-push-notif-server/pulls) are very welcome! :)

