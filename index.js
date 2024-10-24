import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';


// Initilize PRx environment
import fs from 'node:fs';
var gConnections = {};

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
//const SYSTEM_MESSAGE = 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.';

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    //'rate_limits.updated',
    'response.done',
    //'input_audio_buffer.committed',
    //'input_audio_buffer.speech_stopped',
    //'input_audio_buffer.speech_started',
    //'session.created',
    //'session.updated',   // Prints the RT API session details
    'conversation.item.input_audio_transcription.completed',
    //'response.text.delta',
    'response.text.done',
    //'response.audio_transcript.delta',
    'response.audio_transcript.done',
    'response.function_call_arguments.done'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    let host = (request.headers.host.indexOf("posterosrx.com") > 0)?request.headers.host+"/twilrtapi":request.headers.host;
    console.log("\nIncoming Call.. from ", host);
    console.log("CallSid==>", request.body.CallSid,"\n\n\n");
    console.log("Caller==>", request.body.Caller);
    gConnections[request.body.CallSid] = request.body;
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <!-- <Say>Hi there! How can I help you?</Say> -->
                              <Connect>
                                  <Stream url="wss://${host}/media-stream/${request.body.CallSid}" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream/:CallSid', { websocket: true }, (connection, req) => {
        console.log('Client connected');
        const Client = gConnections[req.params.CallSid];
        //console.log(req.headers);
        //console.log(req.params.CallSid);
        //console.log(gConnections[req.params.CallSid])
        console.log("****\n\n");

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        // Prx session specific variables
        let tokens = {total:0,input:0,output:0,input_cached:0,input_text:0,input_audio:0,output_text:0,output_audio:0};
        let tokenUsage = {};

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const prxContext = readFile('assistants/MSL-Coaching.txt');
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad', silence_duration_ms:1000 },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: {model:"whisper-1"}, // Added
                    voice: VOICE,
                    //instructions: SYSTEM_MESSAGE,
                    instructions: prxContext,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            //console.log('Node:Sending session update to RT:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            // sendInitialConversationItem();

            // Push the Posteros Context
            initPrxContext();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Node:Sending initial conversation item to RT:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        const initPrxContext = () => {
            // Push the Context
            //const prxContext = createConversationMessageItem('user', readFile('assistants/MSL-Coaching.txt'));
            //openAiWs.send(JSON.stringify(prxContext));
            let userPropmt = createConversationMessageItem('user', readFile('assistants/Coaching_Oncolixa_product_profile.md'));
            openAiWs.send(JSON.stringify(userPropmt));
            userPropmt = createConversationMessageItem('user', readFile('assistants/Coaching_Oncolixa_MSL_Strategic_initiatives.md'));
            openAiWs.send(JSON.stringify(userPropmt));
            userPropmt = createConversationMessageItem('user', 'Greet the user with "Hello there! I am an AI voice assistant powered by Posteros. How can I help you?');
            openAiWs.send(JSON.stringify(userPropmt));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Node:Calculating elapsed time for truncation to RT: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Node:Sending truncation event to RT:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('RT:Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    switch(response.type) {
                        case 'response.content.done':
                        case 'input_audio_buffer.committed':
                        case 'input_audio_buffer.speech_stopped':
                        case 'input_audio_buffer.speech_started':
                        //case 'session.created':
                        //case 'session.updated':
                        //case 'conversation.item.input_audio_transcription.completed':
                        case 'response.text.delta':
                        case 'response.function_call_arguments.done':
                            console.log(`RT: Received event: ${response.type}`);
                            break;
                        case 'response.text.done':
                            console.log(`RT: Received event: ${response.type} \n>> ${response.text}`);
                            break;
                        case 'conversation.item.input_audio_transcription.completed':
                            console.log(`User:>> ${response.transcript}`);
                            break;
                        case 'response.audio_transcript.done':
                            console.log(`Assistant:<< ${response.transcript}`);
                            break;
                        case 'response.done': // Same as "response.audio_transcript.done" with more info
                            if(response.response.status == "completed"){
                                //console.log(`RT: Received event: ${response.type} \n>> ${JSON.stringify(response.response.usage)}`);
                                countTokens(tokens,response.response.usage);
                                tokenUsage = response.response.usage;
                            }else{
                                console.log(`RT: Received event: ${response.type} >> ${response.response.status_details}`);
                            }
                            break;
                        case 'error':
                            console.error(`RT: Error event received:`, response);
                            break;
                        default:
                            // This case will handle any other event types that are in LOG_EVENT_TYPES
                            // but not explicitly listed in the switch statement
                            console.log(`RT: Received other logged event: ${response.type}`, response);
                    }
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`TWIL:Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('TWIL:Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('TWIL:Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('TWIL:Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('TWIL:Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('RT:Disconnected from the OpenAI Realtime API. Caller:' + Client.Caller);
            // Print stats
            console.log("Token Usage:",  JSON.stringify(tokenUsage));

        });

        openAiWs.on('error', (error) => {
            console.error('RT:Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Node:Server is listening on port ${PORT}`);
});


function createConversationMessageItem(i_role,i_text){
    const convItem = {
        type: 'conversation.item.create',
        item: {
            type: 'message',
            role: i_role,
            content: [
                {
                    type: 'input_text',
                    text: i_text
                }
            ]
        }
    };
    return convItem;
}

function readFile(i_file){
    return fs.readFileSync(i_file, 'utf8');
}

// Keep counting the session tokens
function countTokens(tokens, delta){
    // tokens => {total:0,input:0,output:0,input_cached:0,input_text:0,input_audio:0,output_text:0,output_audio:0};
    // delta ==> {"total_tokens":2224,"input_tokens":1949,"output_tokens":275,"input_token_details":{"cached_tokens":0,"text_tokens":1812,"audio_tokens":137},"output_token_details":{"text_tokens":53,"audio_tokens":222}}
    tokens.total += delta.total_tokens;
    tokens.input += delta.input_tokens;
    tokens.output += delta.output_tokens;
    
    // Input token details
    tokens.input_cached += delta.input_token_details.cached_tokens;
    tokens.input_text += delta.input_token_details.text_tokens;
    tokens.input_audio += delta.input_token_details.audio_tokens;
    
    // Output token details
    tokens.output_text += delta.output_token_details.text_tokens;
    tokens.output_audio += delta.output_token_details.audio_tokens;
}
