// Synthetic native services for exercising the actual packaged settings UI.
import React from 'react';
import * as ReactModule from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import { createRoot } from 'react-dom/client';

const components = new Map(), releases = [];
window.__ModuleLoader__ = {
  load(descriptor) {
    const modules = { react: ReactModule, 'react/jsx-runtime': JsxRuntime, 'react-dom': ReactDom };
    const plugin = descriptor.factory(name => {
      if (!modules[name]) throw new Error('Unexpected native dependency: ' + name);
      return modules[name];
    });
    plugin.apply({
      effect: create => { const release = create(); releases.push(release); return release; },
      slots: { inject: (_name, create) => create(), register: (slot, component) => { components.set(slot.name, component); return () => components.delete(slot.name); } },
      conversation: { sendSession: async () => ({ kind: 'success' }) },
      sessions: { list: { getSnapshot: () => ({ current: undefined }) }, binding: () => undefined },
    });
    createRoot(document.getElementById('settings')).render(React.createElement(components.get('settings.section')));
  },
};
