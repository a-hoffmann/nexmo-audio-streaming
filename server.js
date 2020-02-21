'use strict'
require('dotenv').load()

const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const expressWs = require('express-ws')(app);

const Nexmo = require('nexmo');
const { Readable } = require('stream');
const speech = require('@google-cloud/speech');

const TIE = require('@artificialsolutions/tie-api-client');

const voiceName = "Brian"

// this is used with the heroku one-click install.
// if you are running locally, use GOOGLE_APPLICATION_CREDENTIALS to point to the file location
let config = null;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS === undefined) {
  config = {
    projectId: 'nexmo-extend',
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    }
  }
}

const client = new speech.SpeechClient(config||null);

const teneoApi = TIE.init(process.env.TENEO_ENGINE_URL);

const nexmo = new Nexmo({
  apiKey: "c600ea20",
  apiSecret: "B1KYUCep1YMMMFsC",
  applicationId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY || './private.key'
});

// initialise session handler, to store mapping between nexmo uuid and engine session id
const sessionHandler = SessionHandler();

var uuid='';
var conversation_uuid='';

app.use(bodyParser.json());

app.get('/ncco', (req, res) => {

  let nccoResponse = [
    {
    "action": "talk",
    "text": "Welcome to a Voice API IVR.",
    "voiceName": voiceName,
    "bargeIn": false
  },
	{
      "action": "connect",
      "endpoint": [{
        "type": "websocket",
        "content-type": "audio/l16;rate=16000",
        "uri": `ws://${req.hostname}/socket`
      }]
    }
  ];

  res.status(200).json(nccoResponse);
});

app.post('/event', (req, res) => {
  console.log('EVENT LOG::', req.body)
  
  if (req.body.direction==='outbound' && req.body.status === 'started') {
  uuid=req.body.uuid
  conversation_uuid=req.body.conversation_uuid
  console.log("setting uuid as", uuid)
  console.log("setting conversation_uuid as", conversation_uuid)
  }
  res.status(204).end();
});

// Nexmo Websocket Handler
app.ws('/socket', (ws, req) => {

  let request ={
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: process.env.LANG_CODE || 'en-US'
    },
    interimResults: false
  };

  const recognizeStream = client
  .streamingRecognize(request)
  .on('error', console.error)
  .on('data', data => {
	  console.log(data);
    console.log(`Transcription: ${data.results[0].alternatives[0].transcript}`);
	
	  if (uuid && conversation_uuid) {
		  // check if we have stored an engine sessionid for this caller
			let teneoSessionId = sessionHandler.getSession(conversation_uuid);

			// send input to engine using stored sessionid and retrieve response
			let teneoResponse = await teneoApi.sendInput(teneoSessionId, { 'text': data.results[0].alternatives[0].transcript, 'channel': 'nexmo_websocket' });
			console.log(`teneoResponse: ${teneoResponse.output.text}`)

			// store engine sessionid for this caller
			sessionHandler.setSession(conversation_uuid, teneoResponse.sessionId);
		  
		  //TEST: stream an audio back
	  const AUDIO_URL = 'https://nexmo-community.github.io/ncco-examples/assets/voice_api_audio_streaming.mp3';
		nexmo.calls.stream.start(uuid, { stream_url: [AUDIO_URL], loop: 0 }, (err, res) => {
			if(err) { console.error(err); }
			else {console.log(res);}
		});
	  }
	  //notes:
	  //uuid + conversation_uuid
	  //https://developer.nexmo.com/voice/voice-api/guides/text-to-speech
    
	//send back a ncco/instruction to speak...
  })
  .on('end', function() {
	  console.log('end')
  });

  ws.on('message', (msg) => {
    if (typeof msg === "string") {
		//Of type {"event":"websocket:connected","content-type":"audio/l16;rate=16000"}
      let config = JSON.parse(msg);
    } else {
      recognizeStream.write(msg);
	  //send to socket
	  // ws.send(testNcco());
    }

  });

  ws.on('close', () => {
    recognizeStream.destroy();
  })
});

function testNcco() {
	const ncco =
	[
		{
			"action": "talk",
			"text": "Howdy partner! I don't understand you yet. From wikipedia: <phoneme alphabet='ipa' ph='dɪˈpaːɹʔmənʔs'>departments</phoneme>",
			"voiceName": voiceName
		}
	];

	return JSON.stringify(ncco);
}

function sendNexmoMessage(teneoResponse, post, res) {

	const ncco =
	[
		{
			"action": "talk",
			"text": "Howdy partner! I don't understand you yet. From wikipedia: <phoneme alphabet='ipa' ph='dɪˈpaːɹʔmənʔs'>departments</phoneme>",
			"voiceName": voiceName
		}/*,
		{
			"action": "input",
			"speech":
				{
					"language": "en-gb" ,
					"uuid": [post.uuid],
					"endOnSilence": 2
				},
			"eventUrl": [WEBHOOK_FOR_NEXMO+pathToAnswer]
		}*/

	];

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(ncco));
}

//Teneo features go here 
/*
function sendToTeneo(userInput) {
const teneoResponse = await teneoApi.sendInput(teneoSessionId, { 'text': userInput, 'channel': 'nexmo_voice' });
}*/
/***
 * SESSION HANDLER
 ***/

function SessionHandler() {

	// Map the Nexmo Conversation UUID to the teneo engine session id.
	// This code keeps the map in memory, which is ok for testing purposes
	// For production usage it is advised to make use of more resilient storage mechanisms like redis
	const sessionMap = new Map();

	return {
		getSession: (userId) => {
			if (sessionMap.size > 0) {
				return sessionMap.get(userId);
			} else {
				return "";
  			}
		},
		setSession: (userId, sessionId) => {
			sessionMap.set(userId, sessionId)
		}
	};
}


const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
