import type { RosObservation } from "./ros-api.js";

export function RosObservationDetails({
  observation,
  unavailable = false,
}: {
  observation: RosObservation | null;
  unavailable?: boolean;
}) {
  if (!observation)
    return <p>ROS観測は未受信です。欠測を0や飛行状態へ補完しません。</p>;
  const { payload: p, timestamp } = observation.message;
  const fresh = (received: string | null) =>
    !unavailable &&
    received !== null &&
    Date.now() >= Date.parse(received) &&
    Date.now() - Date.parse(received) < 3000;
  const position = p.position;
  return (
    <section aria-label="ROS観測">
      <h3>ROS由来の観測値</h3>
      <p>
        送信 {timestamp} / DB受信 {observation.receivedAt} / session{" "}
        {observation.message.sessionId} / sequence{" "}
        {observation.message.sequence}
      </p>
      <dl className="detail-grid">
        <div>
          <dt>バッテリー</dt>
          <dd>{p.battery === null ? "不明" : `${p.battery} %`}</dd>
        </div>
        <div>
          <dt>温度</dt>
          <dd>{p.temperature === null ? "不明" : `${p.temperature} ℃`}</dd>
        </div>
        <div>
          <dt>飛行状態（接続とは別）</dt>
          <dd>
            {p.flightStatus === "UNKNOWN" ? "不明 (UNKNOWN)" : p.flightStatus}
          </dd>
        </div>
        <div>
          <dt>位置</dt>
          <dd>
            {!position ? (
              "不明"
            ) : position.kind === "LOCAL" ? (
              <>
                LOCAL / {position.convention} / frame{" "}
                <code>{position.frameId}</code>
                <br />x {position.pose.x} / y {position.pose.y} / z{" "}
                {position.pose.z} {position.unit}（緯度・経度ではない）
                {position.velocity ? (
                  <p>
                    速度 frame {position.velocity.frameId}: x{" "}
                    {position.velocity.linear.x}, y {position.velocity.linear.y}
                    , z {position.velocity.linear.z}{" "}
                    {position.velocity.linearUnit}; 角速度 x{" "}
                    {position.velocity.angular.x}, y{" "}
                    {position.velocity.angular.y}, z{" "}
                    {position.velocity.angular.z}{" "}
                    {position.velocity.angularUnit}
                  </p>
                ) : (
                  <p>速度は不明</p>
                )}
              </>
            ) : (
              <>
                GEODETIC / 緯度 {position.latitude}° / 経度 {position.longitude}
                ° / 高度 {position.altitude ?? "不明"} {position.unit} /{" "}
                {position.altitudeReference}（海抜・相対高度ではない）
              </>
            )}
          </dd>
        </div>
      </dl>
      <ul>
        {Object.entries(p.quality).map(([name, q]) => (
          <li key={name}>
            {name}: {q.reason} /{" "}
            {fresh(q.receivedAt) &&
            q.reason === "VALID" &&
            fresh(observation.receivedAt)
              ? "新鮮"
              : "古い・欠測・無効（現在値として使わない）"}{" "}
            / {q.timeDomain} / epoch {q.clockEpoch} / stamp{" "}
            {q.stamp
              ? `${q.stamp.sec}.${String(q.stamp.nanosec).padStart(9, "0")}`
              : "不明"}{" "}
            / ROS受信 {q.receivedAt ?? "未受信"}
          </li>
        ))}
      </ul>
      <h4>診断</h4>
      {p.diagnostics.length ? (
        <ul>
          {p.diagnostics.map((d, i) => (
            <li key={i}>
              {d.name}: {d.level} / {d.hardwareId}
            </li>
          ))}
        </ul>
      ) : (
        <p>診断は未取得・無効、または項目なし</p>
      )}
      {p.diagnosticsTruncated && <p>診断は上限により一部省略されています。</p>}
    </section>
  );
}
