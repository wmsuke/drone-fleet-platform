import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// jsdomのbrowser条件でMQTTのWebSocket実装を選ばないよう、TCP fixtureだけNode workerへ分離する。
export async function openMqttFixture(
  url: string,
  clientId: string,
  onMessage: (topic: string, body: Buffer) => void,
  onError: () => void,
) {
  const mqttPath = createRequire(
    resolve(process.cwd(), "apps/dashboard/package.json"),
  ).resolve("mqtt");
  const worker = new Worker(
    `
 const {parentPort,workerData}=require('node:worker_threads');
 const {connect}=require(workerData.mqttPath);
 const client=connect(workerData.url,{clientId:workerData.clientId,reconnectPeriod:0,connectTimeout:5000});
 client.on('error',()=>parentPort.postMessage({type:'error'}));
 client.on('message',(topic,body)=>parentPort.postMessage({type:'message',topic,body:body.toString()}));
 client.once('connect',()=>client.subscribe('fleet/v1/devices/+/commands',{qos:1},error=>parentPort.postMessage({type:error?'error':'ready'})));
 parentPort.on('message',m=>client.publish(m.topic,m.body,{qos:1,retain:false},error=>parentPort.postMessage({type:'published',id:m.id,error:!!error})));
 `,
    { eval: true, workerData: { mqttPath, url, clientId } },
  );
  let next = 0;
  const pending = new Map<
    number,
    {
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let readyResolve: () => void;
  let readyReject: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(
    () => readyReject(new Error("MQTT接続期限切れ")),
    10000,
  );
  worker.on("error", (e) => {
    readyReject(e instanceof Error ? e : new Error(String(e)));
    onError();
  });
  worker.on(
    "message",
    (m: {
      type: string;
      topic: string;
      body: string;
      id: number;
      error: boolean;
    }) => {
      if (m.type === "ready") {
        clearTimeout(timer);
        readyResolve();
      }
      if (m.type === "error") {
        readyReject(new Error("MQTT fixture error"));
        onError();
      }
      if (m.type === "message") onMessage(m.topic, Buffer.from(m.body));
      if (m.type === "published") {
        const p = pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(m.id);
          if (m.error) p.reject(new Error("MQTT publish error"));
          else p.resolve();
        }
      }
    },
  );
  try {
    await ready;
  } catch (e) {
    clearTimeout(timer);
    await worker.terminate();
    throw e;
  }
  return {
    async publishAsync(
      topic: string,
      body: string,
      _options: { qos: number; retain: boolean },
    ) {
      if (_options.qos !== 1 || _options.retain)
        throw new Error("fixtureはQoS1・非retainedのみ");
      const id = next++;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("MQTT publish期限切れ"));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, topic, body });
      });
    },
    async endAsync(_force: boolean) {
      if (!_force) throw new Error("fixtureは強制終了のみ");
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("fixture終了"));
      }
      pending.clear();
      await worker.terminate();
    },
  };
}
