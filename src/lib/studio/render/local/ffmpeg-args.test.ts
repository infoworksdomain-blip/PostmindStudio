import { describe, expect, it } from 'vitest';
import { slideshowEdit, wallOfTextEdit } from '../../../../../test/helpers/local-render-fixtures';
import {
  baseSegments,
  hasAudio,
  loudnessArgs,
  motionExpr,
  renderArgs,
  zoompanFilter,
  type PreparedTimeline,
} from './ffmpeg-args';
import { readTimeline, type LayerClip, type LocalTimeline } from './timeline';

/** Prepared files the way prepare.ts names them (no media needed to build the argv). */
function prepare(timeline: LocalTimeline): PreparedTimeline {
  return {
    timeline,
    base: timeline.base.map((clip, i) => {
      const s = clip.source;
      if (s.kind === 'video')
        return {
          kind: 'video',
          file: `in-${i}.mp4`,
          fit: 'cover',
          trimSec: s.trimSec,
          crop: s.crop,
        };
      if (s.kind === 'image' && s.kenBurns)
        return { kind: 'kenBurns', file: `kb-${i}.jpg`, kenBurns: s.kenBurns };
      return { kind: 'still', file: s.kind === 'image' ? `still-${i}.jpg` : `card-${i}.png` };
    }),
    layers: timeline.layers.map((_, i) => ({
      kind: 'image',
      file: `layer-${i}.png`,
      x: 54,
      y: 1500,
    })),
    audio: timeline.audio.map(() => 'in-music.mp3'),
  };
}

function graphOf(args: string[]): string[] {
  return (args[args.indexOf('-filter_complex') + 1] ?? '').split(';');
}

const LOUDNESS = {
  inputI: -20.5,
  inputTp: -4.1,
  inputLra: 3.2,
  inputThresh: -31,
  targetOffset: 0.4,
};

describe('renderArgs — slideshow (golden)', () => {
  const timeline = readTimeline(slideshowEdit());
  const args = renderArgs(prepare(timeline), LOUDNESS);

  it('feeds every picture, layer and music clip as its own input, in order', () => {
    const head = args.slice(3, args.indexOf('-filter_complex'));
    const inputs: string[][] = [];
    let current: string[] = [];
    head.forEach((a, i) => {
      current.push(a);
      if (head[i - 1] === '-i') {
        inputs.push(current);
        current = [];
      }
    });
    // Slide 1 runs 0.5 s longer under slide 2's fade (3 s), slide 2 under slide 3's wipe.
    expect(inputs).toEqual([
      ['-loop', '1', '-framerate', '30', '-t', '3', '-i', 'card-0.png'],
      ['-i', 'kb-1.jpg'],
      ['-loop', '1', '-framerate', '30', '-t', '3', '-i', 'still-2.jpg'],
      // Captions have no transition: one image frame each, shown in their window.
      ['-i', 'layer-0.png'],
      ['-i', 'layer-1.png'],
      ['-t', '8', '-i', 'in-music.mp3'],
    ]);
  });

  it('builds the bottom track as normalised segments joined by xfade at the slide starts', () => {
    const norm = (frames: number) =>
      `setpts=PTS-STARTPTS,fps=30,scale=1080:1920,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames},setpts=PTS-STARTPTS,settb=expr=1/30`;
    const graph = graphOf(args);
    // Slide 1 runs on 15 frames (0.5 s) under slide 2's fade; slide 2 under slide 3's wipe.
    expect(graph[0]).toBe(`[0:v]${norm(90)}[s1]`);
    expect(graph[1]).toBe(
      `[1:v]zoompan=z='1+0.15*on/89':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30,${norm(90)}[s2]`,
    );
    expect(graph[2]).toBe('[s1][s2]xfade=transition=fade:duration=0.5:offset=2.5[b3]');
    expect(graph[3]).toBe(`[2:v]${norm(90)}[s4]`);
    expect(graph[4]).toBe('[b3][s4]xfade=transition=wipeleft:duration=0.5:offset=5[b5]');
  });

  it('overlays the captions in their slide windows and maps the mix through loudnorm', () => {
    const graph = graphOf(args);
    expect(graph[5]).toBe("[b5][3:v]overlay=x=54:y=1500:enable='gte(t,2.5)*lt(t,5)'[o6]");
    expect(graph[6]).toBe("[o6][4:v]overlay=x=54:y=1500:enable='gte(t,5)*lt(t,8)'[o7]");
    expect(graph[7]).toBe('[o7]format=yuv420p[vout8]');
    expect(graph[8]).toBe(
      '[5:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=8,atrim=duration=8,asetpts=PTS-STARTPTS,volume=0.7,afade=t=out:st=7:d=1[a9]',
    );
    expect(graph[9]).toBe(
      '[a9]apad=whole_dur=8,atrim=duration=8,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-20.5:measured_TP=-4.1:measured_LRA=3.2:measured_thresh=-31:offset=0.4:linear=true:print_format=summary[mix10]',
    );
  });

  it('fades an animated layer’s alpha and starts it at its time', () => {
    const t = readTimeline(slideshowEdit());
    const faded: LocalTimeline = {
      ...t,
      layers: t.layers.map((l) => ({ ...l, fadeInSec: 0.3, fadeOutSec: 0.5 })),
    };
    const a = renderArgs(prepare(faded), null);
    expect(a).toEqual(
      expect.arrayContaining(['-loop', '1', '-framerate', '30', '-t', '2.5', '-i', 'layer-0.png']),
    );
    const graph = graphOf(a);
    expect(graph[5]).toBe(
      '[3:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st=2:d=0.5:alpha=1,setpts=PTS-STARTPTS+2.5/TB[l7]',
    );
    expect(graph[6]).toBe(
      "[b5][l7]overlay=x='54':y='1500':eof_action=pass:enable='gte(t,2.5)*lt(t,5)'[o6]",
    );
  });

  it('encodes H.264 + AAC, yuv420p, +faststart, exact length', () => {
    expect(args.slice(args.indexOf('-map'))).toEqual([
      '-map',
      '[vout8]',
      '-map',
      '[mix10]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      '-t',
      '8',
      'local-render.mp4',
    ]);
    expect(args.slice(0, 3)).toEqual(['-hide_banner', '-nostdin', '-y']);
  });
});

describe('renderArgs — static layers and the background video', () => {
  const timeline = readTimeline(wallOfTextEdit('16:9'));
  const prepared = prepare(timeline);
  const args = renderArgs(prepared, null);
  const graph = graphOf(args);

  it('loops and covers the background clip after cropping its letterbox', () => {
    expect(args.slice(3, 9)).toEqual(['-stream_loop', '-1', '-t', '8', '-i', 'in-0.mp4']);
    expect(graph[0]).toMatch(
      /^\[0:v\]crop=iw\*1:ih\*0\.8:iw\*0:ih\*0\.1,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setpts/,
    );
  });

  it('overlays the static AI label for its window (one image frame, repeated)', () => {
    expect(graph[1]).toBe("[s1][1:v]overlay=x=54:y=1500:enable='gte(t,0)*lt(t,8)'[o2]");
  });

  it('leaves the loudness alone when there is no measurement', () => {
    expect(graph.at(-1)).not.toContain('loudnorm');
  });
});

describe('baseSegments', () => {
  it('fills gaps with the backdrop and fades in/out from nothing', () => {
    const t = readTimeline(slideshowEdit());
    const gap: LocalTimeline = {
      ...t,
      totalSec: 9,
      base: [
        { ...(t.base[1] as LocalTimeline['base'][number]), startSec: 0.5, endSec: 3 },
        {
          ...(t.base[2] as LocalTimeline['base'][number]),
          startSec: 3,
          endSec: 6,
          transitionIn: null,
          transitionOut: { xfade: 'fade', durationSec: 0.5 },
        },
      ],
    };
    expect(baseSegments(gap).map((s) => [s.clip, s.startF, s.endF, s.inFrames])).toEqual([
      [null, 0, 15, 0],
      [0, 15, 90, 7], // fade from the gap, at most half the 15-frame gap
      [1, 90, 180, 0],
      [null, 180, 270, 15], // the last clip's fade out crosses into the backdrop
    ]);
    const graph = graphOf(renderArgs(prepare(gap), null));
    expect(graph[0]).toMatch(/^color=c=0x3A4150:s=1080x1920:r=30:d=0\.733,/);
    expect(graph.some((g) => g.includes('concat=n=2:v=1:a=0'))).toBe(true);
  });

  it('fades the first clip in from the backdrop', () => {
    const t = readTimeline(slideshowEdit());
    const first: LocalTimeline = {
      ...t,
      base: t.base.map((c, i) =>
        i === 0 ? { ...c, transitionIn: { xfade: 'fade', durationSec: 0.5 } } : c,
      ),
    };
    const graph = graphOf(renderArgs(prepare(first), null));
    expect(graph).toContain('[s1]fade=t=in:st=0:d=0.5:color=0x3A4150[f2]');
  });
});

describe('zoompanFilter', () => {
  const t = readTimeline(slideshowEdit());
  it.each([
    ['zoomIn', "z='1+0.15*on/59':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"],
    ['zoomOut', "z='1.15-0.15*on/59':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"],
    ['slideLeft', "z='1.15':x='(iw-iw/zoom)*on/59':y='ih/2-(ih/zoom/2)'"],
    ['slideRight', "z='1.15':x='(iw-iw/zoom)*(1-on/59)':y='ih/2-(ih/zoom/2)'"],
    ['slideUp', "z='1.15':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/59'"],
    ['slideDown', "z='1.15':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/59)'"],
  ] as const)('%s', (move, expr) => {
    expect(zoompanFilter({ move, amount: 0.15 }, 60, t)).toBe(
      `zoompan=${expr}:d=60:s=1080x1920:fps=30`,
    );
  });
});

describe('motionExpr', () => {
  const layer = (motion: Partial<LayerClip['motion']>): LayerClip => ({
    source: { kind: 'text', card: {} as never },
    startSec: 2,
    endSec: 6,
    position: 'center',
    offsetX: 0,
    offsetY: 0,
    scale: null,
    opacity: 1,
    fadeInSec: 0.3,
    fadeOutSec: 0,
    rotationDeg: 0,
    motion: { slideIn: null, slideOut: null, wave: null, ...motion },
  });

  it('slides in from the left and out to the top', () => {
    expect(
      motionExpr(
        layer({
          slideIn: { dx: -270, dy: 0, durationSec: 0.5 },
          slideOut: { dx: 0, dy: -288, durationSec: 0.3 },
        }),
        100,
        200,
      ),
    ).toEqual({
      x: '100-270*max(0,1-(t-2)/0.5)',
      y: '200-288*max(0,(t-(6-0.3))/0.3)',
    });
  });

  it('bobs a wave overlay', () => {
    expect(motionExpr(layer({ wave: { amplitudePx: 11.52, periodSec: 0.6 } }), 0, 50).y).toBe(
      '50-11.52*sin(2*PI*(t-2)/0.6)',
    );
  });
});

describe('audio', () => {
  it('measures the mix alone for pass 1', () => {
    const args = loudnessArgs(prepare(readTimeline(slideshowEdit())));
    expect(args.slice(-4)).toEqual(['[mix2]', '-f', 'null', '-']);
    expect(graphOf(args).at(-1)).toBe(
      '[a1]apad=whole_dur=8,atrim=duration=8,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[mix2]',
    );
  });

  it('lays silence under an edit without music, and between clips', () => {
    const t = readTimeline(slideshowEdit());
    const silent: LocalTimeline = { ...t, audio: [] };
    expect(hasAudio(silent)).toBe(false);
    expect(graphOf(renderArgs(prepare(silent), null))).toContain(
      'anullsrc=r=48000:cl=stereo,atrim=duration=8,asetpts=PTS-STARTPTS[z9]',
    );
    const late: LocalTimeline = {
      ...t,
      audio: [
        {
          ...(t.audio[0] as LocalTimeline['audio'][number]),
          startSec: 2,
          lengthSec: 6,
          trimSec: 4.5,
          fadeOutSec: 0,
          fadeInSec: 1,
        },
      ],
    };
    const args = renderArgs(prepare(late), null);
    expect(args).toEqual(expect.arrayContaining(['-ss', '4.5']));
    const graph = graphOf(args);
    expect(graph.at(-1)).toMatch(
      /^\[z\d+\]\[a\d+\]concat=n=2:v=0:a=1,apad=whole_dur=8,atrim=duration=8\[mix\d+\]$/,
    );
    expect(graph.some((g) => g.includes('afade=t=in:st=0:d=1'))).toBe(true);
  });
});

describe('aspect ratios and drafts', () => {
  it.each([
    ['9:16', 'scale=1080:1920'],
    ['16:9', 'scale=1920:1080'],
    ['1:1', 'scale=1080:1080'],
    ['4:5', 'scale=1080:1350'],
  ] as const)('%s segments are normalised to %s', (aspect, scale) => {
    expect(graphOf(renderArgs(prepare(readTimeline(slideshowEdit(aspect))), null))[0]).toContain(
      scale,
    );
  });

  it('scales a 720p draft down at the very end', () => {
    const t = readTimeline(
      slideshowEdit('9:16', { resolution: '1080', scaleTo: 'hd', fps: 30, quality: 'medium' }),
    );
    const args = renderArgs(prepare(t), null);
    expect(graphOf(args).find((g) => g.includes('[vout'))).toMatch(
      /scale=720:1280,format=yuv420p\[vout\d+\]$/,
    );
    expect(args[args.indexOf('-crf') + 1]).toBe('23');
  });
});
