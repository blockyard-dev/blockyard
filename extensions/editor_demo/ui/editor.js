// No Python entry or dependencies. API IDs are local; command references are qualified.
export function activate(editor) {
  const command = `${editor.extensionId}.moveSelection`;
  editor.commands.register('moveSelection', async () => {
    const selected = editor.workspace.getSelection();
    const project = editor.workspace.getIR();
    const script = project.scripts?.find((script) => script.top === selected);
    if (!script) throw new Error('請先選取一個腳本最上面的積木');
    script.x = (script.x ?? 0) + 40;
    await editor.workspace.applyIR(project);
    editor.workspace.select(selected);
    editor.workspace.focus(selected);
  });
  editor.ui.registerToolbarButton({ id: 'moveButton', label: '右移腳本', command });
  editor.ui.registerMenu({ id: 'moveMenu', label: '右移選取的腳本', command });
  editor.ui.registerShortcut({ id: 'moveShortcut', keys: 'Mod+Shift+ArrowRight', command });
  editor.ui.registerStyle('panelStyle', '.editor-demo-info { line-height: 1.7; }');
  editor.ui.registerPanel({
    id: 'inspector', title: '編輯器工具',
    mount(container) {
      const info = document.createElement('p');
      info.className = 'editor-demo-info';
      const select = document.createElement('button');
      select.textContent = '選取第一個腳本';
      select.className = 'button';
      select.onclick = () => {
        const first = editor.workspace.getIR().scripts?.[0];
        if (first) { editor.workspace.select(first.top); editor.workspace.focus(first.top); }
      };
      const refresh = () => { info.textContent = `專案：${editor.project.current().name ?? ''} · 選取：${editor.workspace.getSelection() ?? '無'}`; };
      container.append(info, select);
      refresh();
      const off = editor.events.on('selection.changed', refresh);
      return () => { off(); select.onclick = null; };
    },
  });
}
