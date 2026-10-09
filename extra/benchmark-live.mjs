/** Isolated local benchmark. Never points at, or modifies, a running install.
 * TEST_BACKEND=1 node --import=tsx extra/benchmark-live.mjs
 * Measures HTTP-ingest → SSE reception (not browser paint or remote clocks).
 */
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

process.env.UPTIME_KUMA_HIDE_LOG = "info_db,info_server,error_prometheus";
const require = createRequire(import.meta.url);
const { auth } = require("../server/better-auth");
const TestDB = require("../test/mock-testdb");
const { R } = require("redbean-node");
const express = require("express");
const db = new TestDB(await mkdtemp(join(process.env.FLATLINE_BENCH_TMP ?? tmpdir(), "flatline-live-bench-")));
let server;
const controllers = [];
const readers = [];
const latencies = [];
const lag = monitorEventLoopDelay({resolution:10});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await db.create();
    await auth();
    await auth().api.createUser({body:{name:"bench",email:"bench@noreply.uptime-kuma.internal",password:"Bench-Only-8f4Q2xR9p",role:"admin",data:{username:"bench"}}});
    const owner = await R.findOne("better_auth_user", " email = ? ", ["bench@noreply.uptime-kuma.internal"]);
    const key = R.dispense("api_key");
    key.key = await require("../server/password-hash").generate("isolated-bench-secret");
    key.name = "bench"; key.user_id = owner.id; key.active = 1; key.scopes = "read";
    await R.store(key);
    const token = `uk${key.id}_isolated-bench-secret`;
    const monitors = [];
    for (let i=0;i<10;i++) {
        const m=R.dispense("monitor");
        m.name=`bench-${i}`;m.type="push";m.user_id=owner.id;m.active=1;m.interval=180;m.retryInterval=180;m.timeout=144;m.push_token=`isolated-bench-${i}`;
        await R.store(m);monitors.push(m);
    }
    const app=express();app.use(require("../server/routers/api-router"));app.use(require("../server/routers/api-v1-router"));
    await new Promise(resolve=>{server=app.listen(0,"127.0.0.1",resolve);});
    const base=`http://127.0.0.1:${server.address().port}`;
    for(let i=0;i<3;i++) {
        const controller=new AbortController();controllers.push(controller);
        const response=await fetch(`${base}/api/v1/events`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
        if(response.status!==200)throw new Error(`Stream HTTP ${response.status}`);
        const reader=response.body.getReader();
        readers.push((async()=>{
            let buffer="";const decoder=new TextDecoder();
            try { while(true) {
                const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});
                let boundary;while((boundary=buffer.indexOf("\n\n"))>=0) {
                    const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
                    if(frame.startsWith("data: ")) {
                        const event=JSON.parse(frame.slice(6));
                        if(event.type==="metrics"&&event.metrics.benchSentAt)latencies.push(performance.now()-event.metrics.benchSentAt);
                    }
                }
            }} catch(error) { if(!controller.signal.aborted)throw error; }
        })());
    }
    const cpuStart=process.cpuUsage();const start=performance.now();lag.enable();
    for(let tick=0;tick<10;tick++) {
        await Promise.all(monitors.map(async m=>{
            const response=await fetch(`${base}/api/push/${m.push_token}?telemetry=1`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({metrics:{v:1,sampleInterval:1,benchSentAt:performance.now(),cpu:{percent:tick,cores:20,perCore:Array(20).fill(tick)},mem:{total:64e9,used:2e9,percent:3.1},gpu:{available:false},docker:[]}})});
            if(response.status!==200)throw new Error(`Push HTTP ${response.status}`);
        }));
        await sleep(Math.max(0,start+(tick+1)*1000-performance.now()));
    }
    await sleep(100);
    lag.disable();latencies.sort((a,b)=>a-b);
    const cpu=process.cpuUsage(cpuStart);
    console.log(JSON.stringify({servers:10,hz:1,seconds:10,clients:3,expectedDeliveries:300,receivedDeliveries:latencies.length,
        ingestToStreamP50Ms:latencies[Math.floor(latencies.length*.5)],ingestToStreamP95Ms:latencies[Math.floor(latencies.length*.95)],
        eventLoopP95Ms:lag.percentile(95)/1e6,cpuMs:(cpu.user+cpu.system)/1000,rssMB:process.memoryUsage().rss/1024/1024,
        historyRows:Number(await R.count("monitor_metric")),heartbeatRows:Number(await R.count("heartbeat"))},null,2));
    if(latencies.length!==300)throw new Error("Missing stream deliveries");
} finally {
    lag.disable();controllers.forEach(c=>c.abort());await Promise.allSettled(readers);
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.destroy();
}
