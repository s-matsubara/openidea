import { Tabs } from "@/ui";
import { JjLog } from "./JjLog";
import { JjWorkspacesPanel } from "./jjWorkspaces";
import { useJjWindow } from "./jjWindowState";
import styles from "./GitLog.module.css";

const tabs = [
  { id: "log", label: "Log" },
  { id: "workspaces", label: "Workspaces" },
];

export function JjTabs() {
  const tab = useJjWindow((s) => s.tab);
  return (
    <Tabs
      variant="compact"
      className={styles.headerTabs}
      activeId={tab}
      onSelect={(tab) => useJjWindow.setState({ tab })}
      aria-label="Jujutsu"
      panelIdPrefix="openidea-jj"
      items={tabs}
    />
  );
}

export function JjToolWindow() {
  const tab = useJjWindow((s) => s.tab);
  return (
    <div
      className={styles.root}
      role="tabpanel"
      id={`openidea-jj-panel-${tab}`}
      aria-labelledby={`openidea-jj-tab-${tab}`}
    >
      {tab === "workspaces" ? (
        <JjWorkspacesPanel className={styles.worktrees} listClassName={styles.worktreeList} />
      ) : (
        <JjLog />
      )}
    </div>
  );
}
