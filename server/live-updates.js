/** Process-local, bounded fan-out. No replay log: reconnects resnapshot REST. */
const subscribers = new Set();
let invalidation;

function publish(event) {
    if (event.type === "invalidate") {
        if (!invalidation) {
            invalidation = setTimeout(() => {
                invalidation = null;
                publish({ type: "resnapshot" });
            }, 100);
            invalidation.unref();
        }
        return;
    }
    if (event.type === "resnapshot") {
        event = { type: "invalidate" };
    }
    for (const receive of subscribers) {
        receive(event);
    }
}

function subscribe(receive) {
    subscribers.add(receive);
    return () => subscribers.delete(receive);
}

function publishHeartbeat(bean, calculator) {
    publish({
        type: "heartbeat",
        monitorId: Number(bean.monitor_id),
        patch: {
            status: bean.status,
            ping: bean.ping ?? null,
            lastCheck: bean.time,
            lastMessage: bean.msg ?? null,
            uptime24h: calculator.get24Hour().uptime,
            uptime7d: calculator.get7Day().uptime,
            uptime30d: calculator.get30Day().uptime,
        },
    });
}

module.exports = { publish, subscribe, publishHeartbeat };
