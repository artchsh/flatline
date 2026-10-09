const { scalarRows, timestamp, percentage } = require("./metrics-history");
const WINDOW_MS = 10 * 60_000;
const windows = new Map();
const warming = new Map();

function sqlTime(time) { return new Date(time).toISOString().replace("T", " ").replace("Z", ""); }

function add(queue, time, percent) {
    if (percent === null) { return; }
    while (queue.length && queue.at(-1).percent <= percent) { queue.pop(); }
    queue.push({ time, percent });
    // Normal 1Hz windows contain at most 600 entries. Bound abusive faster
    // senders too, retaining the highest candidates rather than losing them.
    if (queue.length > 2048) { queue.splice(1, 1); }
}

function currentPeak(id, now = Date.now()) {
    const queue = windows.get(Number(id));
    if (!queue) { return null; }
    while (queue.length && queue[0].time < now - WINDOW_MS) { queue.shift(); }
    return queue.length ? { percent: queue[0].percent, at: new Date(queue[0].time).toISOString() } : null;
}

async function warm(id, now) {
    if (windows.has(id)) { return; }
    if (!warming.has(id)) {
        warming.set(id, (async () => {
            const rows = await scalarRows(id, sqlTime(now - WINDOW_MS), sqlTime(now), 2048);
            const queue = [];
            for (const row of rows.reverse()) { add(queue, timestamp(row.time), percentage(row.cpu)); }
            queue.lastTime = rows.length ? timestamp(rows.at(-1).time) : -Infinity;
            if (windows.size >= 512) { windows.delete(windows.keys().next().value); }
            windows.set(id, queue);
        })().finally(() => warming.delete(id)));
    }
    await warming.get(id);
}

async function recordCPU(id, time, value) {
    id = Number(id);
    const now = timestamp(time);
    await warm(id, now);
    const queue = windows.get(id);
    const end = Math.max(now, queue.lastTime);
    currentPeak(id, end);
    if (now >= queue.lastTime) { add(queue, now, percentage(value)); queue.lastTime = now; }
    return currentPeak(id, end);
}

function forgetCPU(id) { windows.delete(Number(id)); }
function resetCPU() { windows.clear(); warming.clear(); }

module.exports = { recordCPU, currentPeak, forgetCPU, resetCPU };
