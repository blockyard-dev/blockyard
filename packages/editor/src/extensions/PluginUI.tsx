import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EditorRuntime } from './runtime';
import type { PanelSpec } from './types';
import { PanelWindow } from '../components/PanelWindow';
import { t } from '../i18n';

export function PluginActions({ runtime }: { runtime: EditorRuntime }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const execute = (command: string, owner: string) =>
    void runtime.execute(command).catch((e) => runtime.report(owner, e));
  return (
    <div className="plugin-actions">
      {state.menus.length > 0 && (
        <details className="plugin-menu">
          <summary>{t('plugin.menu')}</summary>
          <div>
            {state.menus.map((item) => (
              <button
                className="button"
                key={item.id}
                onClick={() => execute(item.command, item.owner)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </details>
      )}
      {state.toolbar.map((item) => (
        <button className="button" key={item.id} onClick={() => execute(item.command, item.owner)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
function PanelContent({
  panel,
  runtime,
}: {
  panel: PanelSpec & { owner: string };
  runtime: EditorRuntime;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current!;
    let dispose: void | (() => void);
    try {
      dispose = panel.mount(container);
    } catch (e) {
      runtime.report(panel.owner, e);
    }
    return () => {
      try {
        dispose?.();
      } catch (e) {
        runtime.report(panel.owner, e);
      }
      container.replaceChildren();
    };
  }, [panel, runtime]);
  return <div className="plugin-panel-content" ref={ref} />;
}
export function PluginPanels({ runtime }: { runtime: EditorRuntime }) {
  const { panels } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [active, setActive] = useState<string | null>(null);
  const [popped, setPopped] = useState(false);
  const panel = panels.find((p) => p.id === active) ?? panels[0];
  if (!panel) return null;
  const content = (
    <>
      <nav aria-label={t('plugin.panels')}>
        {panels.map((p) => (
          <button
            className={`button${panel.id === p.id ? ' is-primary' : ''}`}
            key={p.id}
            onClick={() => setActive(p.id)}
          >
            {p.title}
          </button>
        ))}
        <button className="button" onClick={() => setPopped(!popped)}>
          {popped ? t('plugin.popIn') : t('plugin.popOut')}
        </button>
      </nav>
      <PanelContent key={panel.id} panel={panel} runtime={runtime} />
    </>
  );
  return popped ? (
    <PanelWindow onClose={() => setPopped(false)}>{content}</PanelWindow>
  ) : (
    <aside className="plugin-panels">{content}</aside>
  );
}
