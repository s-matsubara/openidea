/**
 * Commit Options popup (the gear next to Commit, after IDEA's): Git author and
 * sign-off, before-commit modifications, Git hooks and the commit checks. The
 * checks are the Settings › Version Control › Commit values, edited in place.
 */
import { useRef, useState, type ReactNode } from "react";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { useWorkflowSettings, workflowSettings } from "@/platform/workflowSettings";
import { useCommitCheckProviders } from "@/workbench/contributions";
import { Checkbox, IconButton, Input, Popup, T } from "@/ui";
import { useCommit } from "./commitStore";
import styles from "./CommitView.module.css";

type CommitCheck = "reformat" | "optimizeImports" | "cleanup" | "analyzeCode" | "checkTodo";

async function setCheck(key: CommitCheck, value: boolean) {
  if (!isTauri()) return;
  try {
    await call(commands.settingsSet("global", `vcs.commit.${key}`, JSON.stringify(value)));
    await loadSettings();
  } catch {
    // keep the previous value
  }
}

async function setContributedCheck(key: string, on: boolean) {
  if (!isTauri()) return;
  const off = new Set(workflowSettings().vcs.commit.disabledPluginChecks);
  if (on) off.delete(key);
  else off.add(key);
  try {
    await call(commands.settingsSet("global", "vcs.commit.disabledPluginChecks", JSON.stringify([...off].sort())));
    await loadSettings();
  } catch {
    // keep the previous value
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.optSection}>
      <h3 className={styles.optTitle}>
        <T>{title}</T>
      </h3>
      <div className={styles.optBody}>{children}</div>
    </section>
  );
}

function Configure() {
  return (
    <button type="button" className={styles.optLink} onClick={() => void executeAction("file.settings", "vcs.commit")}>
      <T>Configure</T>
    </button>
  );
}

/** The options themselves: in the popup, and inline beside the Commit dialog's message. */
export function CommitOptionsBody() {
  const author = useCommit((s) => s.author);
  const signOff = useCommit((s) => s.signOff);
  const runHooks = useCommit((s) => s.runHooks);
  const c = useWorkflowSettings((s) => s.vcs.commit);
  const contributed = useCommitCheckProviders((s) => s.providers).flatMap((p) => p.checks());
  const check = (key: CommitCheck, label: string, extra?: ReactNode) => (
    <div className={styles.optRow}>
      <Checkbox checked={c[key]} onChange={(v) => void setCheck(key, v)} label={label} />
      {extra}
    </div>
  );
  return (
    <>
      <Section title="Git">
        <label className={styles.optField}>
          <span>
            <T>Author:</T>
          </span>
          <Input
            value={author}
            title="Name <email>; empty uses the configured Git user"
            aria-label="Author"
            onChange={(e) => useCommit.setState({ author: e.target.value })}
          />
        </label>
        <Checkbox checked={signOff} onChange={(v) => useCommit.setState({ signOff: v })} label="Sign-off commit" />
      </Section>
      <Section title="Commit Checks">
        {check("reformat", "Reformat code")}
        {check("optimizeImports", "Optimize imports")}
        {check("cleanup", "Cleanup")}
        <Checkbox checked={runHooks} onChange={(v) => useCommit.setState({ runHooks: v })} label="Run Git hooks" />
      </Section>
      <Section title="Advanced Commit Checks">
        {check("analyzeCode", "Analyze code")}
        {check("checkTodo", "Check TODO", <Configure />)}
        {contributed.map((k) => (
          <div key={k.key} className={styles.optRow}>
            <Checkbox
              checked={!c.disabledPluginChecks.includes(k.key)}
              onChange={(v) => void setContributedCheck(k.key, v)}
              label={k.title}
            />
          </div>
        ))}
      </Section>
    </>
  );
}

function JjCommitOptionsBody() {
  const { analyzeCode, checkTodo } = useWorkflowSettings((s) => s.vcs.commit);
  return (
    <>
      <Section title="Advanced Commit Checks">
        <Checkbox
          checked={analyzeCode}
          onChange={(value) => void setCheck("analyzeCode", value)}
          label="Analyze code"
        />
        <Checkbox checked={checkTodo} onChange={(value) => void setCheck("checkTodo", value)} label="Check TODO" />
      </Section>
      <Section title="Commit Message Generation">
        <div className={styles.optRow}>
          <T>Instructions for Generate Commit Message with Agent</T>
          <Configure />
        </div>
      </Section>
    </>
  );
}

export function CommitOptionsButton({ vcs = "git" }: { vcs?: "git" | "jj" }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="settings"
        title="Commit Options"
        size="small"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <Popup
          open
          anchor={anchor}
          placement="top-start"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Commit Options"
          className={styles.options}
        >
          <div tabIndex={-1} data-autofocus className={styles.optFocus} />
          {vcs === "jj" ? <JjCommitOptionsBody /> : <CommitOptionsBody />}
        </Popup>
      )}
    </>
  );
}
