'use strict'
require('dotenv').load()
const fs = require('fs');
const util = require('util');
const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const expressWs = require('express-ws')(app);
var header = require("waveheader");


const Nexmo = require('nexmo');
const { Readable } = require('stream');
const speech = require('@google-cloud/speech');

const TIE = require('@artificialsolutions/tie-api-client');

const voiceName = process.env.NEXMO_VOICE;
const lang = process.env.LANG_CODE;

let config = null;
var sessionUniqueID = null;
var striptags = require('striptags');
var endCall = false;
var streamResponse;

const nexmo = new Nexmo({
  apiKey: process.env.NEXMO_API_KEY,
  apiSecret: process.env.NEXMO_API_SECRET,
  applicationId: process.env.APP_ID,
  privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
});

/**
 * Separate configuration file for Google cloud STT.
 * NOTE: You _have_ to keep a seperate variable for projectId and KeyFileName, otherwise there will be an exception.
 * You can allow Google TTS and STT in the same project for both variables.
 * @type {{keyFilename: string, projectId: string}}
 */
const stt_config = {
    projectId: 'stt-tts-1582249946541',
    credentials: {
		client_email: process.env.GOOGLE_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
	}
};

const stt = require('@google-cloud/speech');
const google_stt_client = new stt.SpeechClient(stt_config);

/**
 * Separate configuration file for Google cloud TTS.
 * NOTE: You _have_ to keep a seperate variable for projectId and KeyFileName, otherwise there will be an exception.
 * You can allow Google TTS and STT in the same project for both variables.
 * @type {{keyFilename: string, projectId: string}}
 */

const tts_config = {
    projectId: 'stt-tts-1582249946541',
    credentials: {
		client_email: process.env.GOOGLE_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
	}
};

const tts = require('@google-cloud/text-to-speech');
const google_tts_client = new tts.TextToSpeechClient(tts_config);

/**
 * Variables
 */

// Global variable to keep track of the caller
var CALL_UUID = null;
// Change between "google" or "nexmo"
var tts_response_provider = process.env.TTS_RESPONSE_PROVIDER;
var ngrok_hostname = "";

/**
 *
 * @type {{interimResults: boolean, config: {sampleRateHertz: number, encoding: string, languageCode: string}}}
 */
/**
 * Configuration variable for Google.
 * @type {{interimResults: boolean, config: {sampleRateHertz: number, encoding: string, languageCode: string}}}
 */

let stream_request ={
    config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-SG' //special config for SG STT
    },
    interimResults: false
};

/**
 * Server configuration
 */

app.use(bodyParser.json());
app.use(express.static('public'));
app.use(express.static('files'));

/**
 * GET response for Nexmo to retrieve the locally saved Google TTS audio file.
 */

app.get('/' + AUDIO_FILE_NAME, function(req, res){
    res.sendFile(`${__dirname}/` + AUDIO_FILE_NAME);
});

/**
 * POST response for the default events parameter
 */

app.post('/webhooks/events', (req, res) => {
    res.sendStatus(200);
});

/**
 * GET response for the default answer parameter. Required to initialise the conversation with caller.
 */

app.get('/webhooks/answer', (req, res) => {

    ngrok_hostname = `${req.hostname}`;

    let nccoResponse = [
	{
    "action": "talk",
    "text": ((voiceName==="Mizuki") ? "IVRシステムへようこそ。 " : "Welcome to the IVR system"),
    "voiceName": voiceName,
    "bargeIn": false
  },
        {
            "action": "connect",
            "endpoint": [{
                "type": "websocket",
                "content-type": "audio/l16;rate=16000",
                "uri": `ws://${req.hostname}/socket`,
                // The headers parameter will be passed in the config variable below.
                "headers": {
                    "language": lang,
                    "uuid": req.url.split("&uuid=")[1].toString()
                }
            }],
        }
    ];
    res.status(200).json(nccoResponse);
});

/**
 * Websocket communicating with Nexmo and the end-user via the active phone call.
 * CALL_UUID parameter is passed to
 */

app.ws('/socket', (ws, req) => {
	
	streamResponse = ws;
	
    // Initialised after answer webhook has started
    ws.on('message', (msg) => {

        if (typeof msg === "string") {
            // UUID is captured here.
            let config = JSON.parse(msg);
            CALL_UUID = config["uuid"];
        }

        // Send the user input as byte array to Google TTS
        else {
            sendStream(msg) //get the final result of this
        }
    });

    // Initiated when caller hangs up.
    ws.on('close', () => {
        recognizeStream.destroy();
    })
});

/**
 * Initialise the server after defining the server functions.
 */
const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Server started using port ${port}!`));

async function sendStream(msg) {
    await recognizeStream.write(msg);
}

/**
 * Google TTS function. When the data has been retrieved from Google cloud, processing from text to speech is started.
 */
const recognizeStream = google_stt_client
    .streamingRecognize(stream_request)
    .on('error', console.error)
    .on('data', data => {
        processContent(data.results[0].alternatives[0].transcript);
    });

/**
 * processContent is an asynchronous function to send input and retrieve output from a Teneo instance.
 * After this is completed, Google or Nexmo TTS is initiated.
 * @param transcript Transcripted text from Google
 */

async function processContent(transcript) {
    await TIE.sendInput(process.env.TENEO_ENGINE_URL, sessionUniqueID, { text: transcript} )
        .then((response) => {
                console.log("Speech-to-text user output: " + transcript);
                transcript = striptags(response.output.text);
                console.log("Bot response: " + transcript);
				if (response.output.parameters.endCall==="true") {
					console.log('set endcall to true');
					endCall=true;
				}
                return response
            }
        ).then(({sessionId}) => sessionUniqueID = sessionId);

    sendTranscriptVoiceNoSave(transcript);
}

/**
 * sendTranscriptVoiceNoSave performs Google/Nexmo TTS operation and Nexmo returns the audio back to the end user. 
 * Does not save the file as a .MP3 file in the app folder.
 * @param transcript Message to be sent back to the end user
 */

async function sendTranscriptVoiceNoSave(transcript) {

    // Performs the text-to-speech request
    const [response] = await google_tts_client.synthesizeSpeech({
        input: {text: transcript},
        // Select the language and SSML voice gender (optional) 
        voice: {languageCode: lang, ssmlGender: 'FEMALE'},
        // select the type of audio encoding
        audioConfig: {audioEncoding: 'LINEAR16', sampleRateHertz: 16000}, 
    });
	
	

    // Google voice response
    if(tts_response_provider === "google") {
		formatForNexmo(response.audioContent,640).forEach(function(aud) {
			streamResponse.send(aud);
		});
		if (endCall) {
					nexmo.calls.update(CALL_UUID,{action:'hangup'},console.log('call ended'))
				}
    }

    // Nexmo voice response
    else if(tts_response_provider === "nexmo") {
        nexmo.calls.talk.start(CALL_UUID, { text: transcript, voice_name: voiceName, loop: 1 }, (err, res) => {
            if(err) { console.error(err); }
            else {
                console.log("Nexmo response sent: " + res);
				if (endCall) {
					nexmo.calls.update(CALL_UUID,{action:'hangup'},console.log('call ended'))
				}
            }
        });
    }	
}
/**
 * Constructs the byte array to be written to the Nexmo Websocket, in packets of byteLen length.
 * @param ac Audio response Buffer
 */
function formatForNexmo(ac,byteLen) {
	var totalByteLength = Buffer.byteLength(ac);
   
    var msgLength = byteLen; // bytes
   
    var bufQueue=[];
    for (var i=0;i<totalByteLength;i+=msgLength) {
	    bufQueue.push(ac.slice(i,i+msgLength));
    }
    return bufQueue;
}