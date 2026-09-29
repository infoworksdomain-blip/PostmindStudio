// Project templates (spec 8.6): GET/POST /templates, GET/DELETE /templates/:id. Built-ins plus
// the organisation's own; "Save as template" on the Review screen adds one from a project.
import type {
  AutoPublishTarget,
  ProjectTemplate,
  PublishDefaults,
} from '@/components/studio/automation/automation';
import { DemoHttpError, route } from '../registry';
import { CONNECTIONS, DEMO_ORG_ID, TEMPLATES } from '../ids';
import { ago, DAY, getProject, newId, nowIso } from './projects-store';

interface Blueprint {
  treatment: string;
  durationSec: number;
  purpose: string;
}
const bp = (treatment: string, durationSec: number, purpose: string): Blueprint => ({
  treatment,
  durationSec,
  purpose,
});
const vertical = (platforms: string[], duration: number) =>
  platforms.map((platform) => ({ platform, aspectRatio: '9:16', duration }));

const templates: ProjectTemplate[] = [
  {
    id: TEMPLATES.introduce.id,
    organisationId: null,
    builtIn: true,
    name: TEMPLATES.introduce.name,
    category: 'introduction',
    targetFormats: vertical(['tiktok', 'instagram_reel', 'youtube_short'], 30),
    shotBlueprint: {
      shots: [
        bp('AI_AVATAR', 5, 'Say who you are'),
        bp('AI_CLIP', 8, 'Show what you make'),
        bp('STOCK_FOOTAGE', 8, 'Show who you make it for'),
        bp('AI_CLIP', 6, 'Proof: a happy customer'),
        bp('TEXT_CARD', 3, 'Where to find you'),
      ],
    },
    publishDefaults: null,
    createdAt: ago(200 * DAY),
  },
  {
    id: 'tpl-behind-the-scenes',
    organisationId: null,
    builtIn: true,
    name: 'Behind the scenes',
    category: 'behind_the_scenes',
    targetFormats: vertical(['tiktok', 'instagram_reel'], 20),
    shotBlueprint: {
      shots: [
        bp('AI_CLIP', 3, 'Early-morning hook'),
        bp('AI_CLIP', 5, 'The craft up close'),
        bp('AI_CLIP', 5, 'The team at work'),
        bp('AI_CLIP', 4, 'The finished product'),
        bp('TEXT_CARD', 3, 'Call to action'),
      ],
    },
    publishDefaults: null,
    createdAt: ago(190 * DAY),
  },
  {
    id: 'tpl-product-drop',
    organisationId: null,
    builtIn: true,
    name: 'Limited product drop',
    category: 'product_launch',
    targetFormats: vertical(['tiktok', 'youtube_short'], 15),
    shotBlueprint: {
      shots: [
        bp('MOTION_GRAPHICS', 2, 'Countdown hook'),
        bp('AI_CLIP', 5, 'Hero product reveal'),
        bp('AI_CLIP', 5, 'Detail shots'),
        bp('TEXT_CARD', 3, 'When and where'),
      ],
    },
    publishDefaults: null,
    createdAt: ago(180 * DAY),
  },
  {
    id: TEMPLATES.weeklySpecial.id,
    organisationId: DEMO_ORG_ID,
    builtIn: false,
    name: TEMPLATES.weeklySpecial.name,
    category: 'weekly_special',
    targetFormats: vertical(['tiktok', 'instagram_reel'], 15),
    shotBlueprint: {
      shots: [
        bp('AI_CLIP', 3, 'This week’s special'),
        bp('AI_CLIP', 5, 'Close-up of the bake'),
        bp('STOCK_FOOTAGE', 4, 'Enjoyed with a coffee'),
        bp('TEXT_CARD', 3, 'Price and days'),
      ],
    },
    publishDefaults: {
      publishPolicy: 'AUTO_ON_APPROVAL',
      reviewPolicy: 'REQUIRE_APPROVAL',
      targets: [
        {
          platform: 'tiktok',
          connectionId: CONNECTIONS.tiktok.id,
          hashtags: ['weeklyspecial', 'leeds'],
        },
      ],
    },
    createdAt: ago(40 * DAY),
  },
  // 17.9: the organisation's own templates cover the remaining categories, so the Templates
  // screen shows every category label translated (templates.categories.*).
  orgTemplate('tpl-org-recipe', 'Recipe of the week', 'food', 30, [
    bp('AI_CLIP', 3, 'The finished bake'),
    bp('AI_CLIP', 6, 'Method in three steps'),
    bp('TEXT_CARD', 3, 'Save for later'),
  ]),
  orgTemplate('tpl-org-slow-sunday', 'Slow Sunday', 'lifestyle', 26, [
    bp('STOCK_FOOTAGE', 4, 'Morning light at home'),
    bp('AI_CLIP', 5, 'Coffee and a pastry'),
    bp('TEXT_CARD', 3, 'Open 9–2 on Sundays'),
  ]),
  orgTemplate('tpl-org-review-tweet', 'Customer review, read aloud', 'tweet_video', 18, [
    bp('MOTION_GRAPHICS', 5, 'The review on screen'),
    bp('AI_CLIP', 4, 'The bake it mentions'),
  ]),
  orgTemplate('tpl-org-meet-tom', 'Meet Tom, our head baker', 'introduction', 12, [
    bp('AI_AVATAR', 5, 'Tom says hello'),
    bp('AI_CLIP', 6, 'His favourite bake'),
  ]),
  orgTemplate('tpl-org-friday-prep', 'Friday prep, behind the scenes', 'behind_the_scenes', 9, [
    bp('AI_CLIP', 4, 'Ovens on at 4am'),
    bp('AI_CLIP', 5, 'Shaping the weekend loaves'),
  ]),
  orgTemplate('tpl-org-spring-copy', 'Saved from “Spring menu launch”', 'custom', 2, [
    bp('AI_CLIP', 4, 'Hook'),
    bp('AI_CLIP', 5, 'Three new plates'),
    bp('TEXT_CARD', 3, 'Offer'),
  ]),
];

function orgTemplate(
  id: string,
  name: string,
  category: string,
  daysAgo: number,
  shots: Blueprint[],
): ProjectTemplate {
  return {
    id,
    organisationId: DEMO_ORG_ID,
    builtIn: false,
    name,
    category,
    targetFormats: vertical(['tiktok', 'instagram_reel'], 20),
    shotBlueprint: { shots },
    publishDefaults: null,
    createdAt: ago(daysAgo * DAY),
  };
}

const copy = (t: ProjectTemplate): ProjectTemplate =>
  JSON.parse(JSON.stringify(t)) as ProjectTemplate;

export function findProjectTemplate(id: string): ProjectTemplate | null {
  const t = templates.find((x) => x.id === id);
  return t ? copy(t) : null;
}

route('GET', '/templates', ({ query }) => {
  const category = query.get('category');
  return { data: templates.filter((t) => !category || t.category === category).map(copy) };
});

route('GET', '/templates/:id', ({ params }) => {
  const t = findProjectTemplate(params.id ?? '');
  if (!t) throw new DemoHttpError(404, 'not_found', 'Template not found');
  return { template: t };
});

route('DELETE', '/templates/:id', ({ params }) => {
  const i = templates.findIndex((t) => t.id === params.id);
  const t = templates[i];
  if (!t) throw new DemoHttpError(404, 'not_found', 'Template not found');
  if (t.builtIn) throw new DemoHttpError(409, 'conflict', 'Built-in templates are read-only');
  templates.splice(i, 1);
  return { deleted: true };
});

route('POST', '/templates', ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const category = typeof b.category === 'string' && b.category ? b.category : 'custom';
  if (!name) throw new DemoHttpError(400, 'validation_error', 'name is required');
  if (!/^[a-z0-9_]{1,60}$/.test(category))
    throw new DemoHttpError(
      400,
      'validation_error',
      'category: lowercase letters, digits and _ only',
    );
  const project = getProject(typeof b.projectId === 'string' ? b.projectId : '');
  if (project.sourceType === 'SLIDESHOW')
    throw new DemoHttpError(409, 'conflict', 'Save slideshows with POST /slideshow-templates');
  const script = project.scripts[0];
  if (!script || script.shots.length === 0)
    throw new DemoHttpError(
      400,
      'validation_error',
      'Generate the project first: a template is saved from its script',
    );
  const targets = (
    (project.metadata?.autoPublish as { targets?: AutoPublishTarget[] } | undefined)?.targets ?? []
  ).map((t) => ({ ...t }));
  const publishDefaults: PublishDefaults = {
    publishPolicy: project.publishPolicy as PublishDefaults['publishPolicy'],
    reviewPolicy: project.reviewPolicy as PublishDefaults['reviewPolicy'],
    targets,
  };
  const template: ProjectTemplate = {
    id: newId('tpl'),
    organisationId: DEMO_ORG_ID,
    builtIn: false,
    name: name.slice(0, 120),
    category,
    targetFormats: project.targetFormats.map((f) => ({
      platform: f.platform,
      aspectRatio: f.aspectRatio,
      duration: f.duration,
    })),
    shotBlueprint: {
      shots: script.shots.map((s) =>
        bp(s.visualTreatment, s.durationSec, s.onScreenText ?? s.sceneDescription.slice(0, 60)),
      ),
    },
    publishDefaults,
    createdAt: nowIso(),
  };
  templates.push(template);
  return { status: 201, body: { template: copy(template) } };
});
