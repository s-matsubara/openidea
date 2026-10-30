import { tx } from "@/platform/i18n";
import styles from "./GitLog.module.css";

export function LineStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.lineStats}>
      <span className={styles.lineAdded} aria-label={added === 1 ? tx`${added} line added` : tx`${added} lines added`}>
        +{added}
      </span>
      <span
        className={styles.lineRemoved}
        aria-label={removed === 1 ? tx`${removed} line deleted` : tx`${removed} lines deleted`}
      >
        −{removed}
      </span>
    </span>
  );
}
