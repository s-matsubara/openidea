import { laneColor, type GraphRow } from "./graph";
import styles from "./JjGraphCell.module.css";

const LOG_ROW_HEIGHT = 26;
const LANE = 14;

function x(lane: number) {
  return LANE / 2 + lane * LANE;
}

function seg(fromX: number, fromY: number, toX: number, toY: number) {
  return `M${fromX} ${fromY}L${toX} ${toY}`;
}

export function JjGraphCell({ row, head }: { row: GraphRow; head?: boolean }) {
  const width = row.width * LANE;
  const cy = LOG_ROW_HEIGHT / 2;
  return (
    <svg className={styles.graph} width={width} height={LOG_ROW_HEIGHT} aria-hidden>
      {row.up.map((s, i) => (
        <path
          key={`u${i}`}
          d={
            seg(x(s.fromX ?? s.from), 0, x(s.toX ?? s.to), cy) + (s.arrow ? arrowHead(x(s.fromX ?? s.from), 0, -1) : "")
          }
          stroke={laneColor(s.color)}
          strokeLinecap={s.dashed ? "butt" : "square"}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {row.down.map((s, i) => (
        <path
          key={`d${i}`}
          d={
            seg(x(s.fromX ?? s.from), cy, x(s.toX ?? s.to), LOG_ROW_HEIGHT) +
            (s.arrow ? arrowHead(x(s.toX ?? s.to), LOG_ROW_HEIGHT, 1) : "")
          }
          stroke={laneColor(s.color)}
          strokeLinecap={s.dashed ? "butt" : "square"}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {head ? (
        <>
          <circle
            cx={x(row.lane)}
            cy={cy}
            r={5}
            fill="var(--log-row-bg, var(--bg-app))"
            stroke={laneColor(row.color)}
            strokeWidth={1.5}
          />
          <circle cx={x(row.lane)} cy={cy} r={2.5} fill={laneColor(row.color)} />
        </>
      ) : (
        <circle cx={x(row.lane)} cy={cy} r={3.8} fill={laneColor(row.color)} />
      )}
    </svg>
  );
}

/** Arrow head at (`px`, `py`) pointing up (`dir` -1) or down (1): a long edge continues. */
function arrowHead(px: number, py: number, dir: 1 | -1) {
  const back = py - dir * 4;
  return `M${px - 3} ${back}L${px} ${py}L${px + 3} ${back}`;
}
