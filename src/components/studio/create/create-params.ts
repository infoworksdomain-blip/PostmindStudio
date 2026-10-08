import type { Reference } from './body';

// The /new query string: a library reference (?reference=&mode=) or a template chosen on
// /templates (?template= / ?slideshowTemplate=). body.ts re-exports these.

export function parseReference(id: string | undefined, mode: string | undefined): Reference | null {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { id, mode: mode?.toUpperCase() === 'TEMPLATE' ? 'TEMPLATE' : 'INSPIRE' };
}

/** A template chosen on /templates ("Use template"): /new?template=<id> or ?slideshowTemplate=<id>. */
export interface InitialTemplate {
  kind: 'project' | 'slideshow';
  id: string;
}

const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseInitialTemplate(
  projectTemplate: string | undefined,
  slideshowTemplate: string | undefined,
): InitialTemplate | null {
  if (projectTemplate && TEMPLATE_ID.test(projectTemplate))
    return { kind: 'project', id: projectTemplate };
  if (slideshowTemplate && TEMPLATE_ID.test(slideshowTemplate))
    return { kind: 'slideshow', id: slideshowTemplate };
  return null;
}
