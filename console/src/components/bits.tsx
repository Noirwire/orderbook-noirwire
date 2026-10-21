import type { ReactNode } from "react";

export type Tone = "ok" | "warn" | "danger" | "neutral";

/** Fresh within `fresh` seconds, still usable within `usable`, stale beyond. */
export function ageTone(seconds: number, fresh: bigint, usable: bigint): Tone {
  if (BigInt(seconds) <= fresh) return "ok";
  return BigInt(seconds) <= usable ? "warn" : "danger";
}

export const StateMark = ({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) => <span className={`state ${tone}`}>{children}</span>;

export const Stat = ({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) => (
  <div className="stat">
    <span className="label">{label}</span>
    <span className="value">{value}</span>
    {sub !== undefined && <span className="sub">{sub}</span>}
  </div>
);

export const Facts = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="facts">
    {rows.map(([label, value]) => (
      <div key={label} style={{ display: "contents" }}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export const Heading = ({
  title,
  lead,
}: {
  title: string;
  lead: ReactNode;
}) => (
  <>
    <h1>{title}</h1>
    <p className="lead">{lead}</p>
  </>
);
