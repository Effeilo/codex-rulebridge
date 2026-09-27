"""Render an English illustrated IDE demo, backed by CLI and hook assertions.

Optional media tooling: Pillow and imageio-ffmpeg (or FFMPEG env path).
Usage: python scripts/render-demo.py
Outputs: assets/demo.mp4 and assets/demo-preview.png.
The Codex conversation is illustrative, not a screen recording.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
W, H, FPS, DURATION = 1600, 1000, 24, 48
ASSETS = ROOT / 'assets'
WORK = ROOT / 'work/video'
ASSETS.mkdir(exist_ok=True)
WORK.mkdir(parents=True, exist_ok=True)
RULES = {
    'general.md': '# Project conventions\n\n- Keep changes focused.\n- Report the checks you actually ran.\n',
    'frontend.md': '---\npaths:\n  - "src/components/**/*.tsx"\n---\n# Frontend\n\n- Use a native button element.\n- Set type="button" for non-submit actions.\n',
    'backend.md': '---\npaths:\n  - "src/api/**"\n---\n# Backend\n\n- Validate request payloads.\n',
}
with tempfile.TemporaryDirectory(prefix='rulebridge-demo-') as temp:
    repo = Path(temp).resolve()
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    source = repo / '.agents/rules'
    source.mkdir(parents=True)
    for name, body in RULES.items():
        (source / name).write_text(body)
    component = repo / 'src/components/SaveButton.tsx'
    component.parent.mkdir(parents=True)
    component.write_text('export function SaveButton() {\n  return <div>Save</div>;\n}\n')
    def cli(*args):
        return subprocess.run(['node', str(ROOT / 'src/cli.mjs'), *args, '--root', str(repo)], text=True, capture_output=True, check=True).stdout.strip()
    initial = cli('init')
    assert not (repo / '.claude').exists()
    assert (repo / '.codex/hooks.json').is_file()
    def hook(event, **extra):
        data = dict(session_id='render-demo', cwd=str(repo), hook_event_name=event, **extra)
        result = subprocess.run(['node', str(repo / '.codex/rulebridge/hook.mjs')], input=json.dumps(data), text=True, capture_output=True, check=True)
        return json.loads(result.stdout).get('hookSpecificOutput', {})
    startup = hook('SessionStart')
    assert 'Keep changes focused' in startup['additionalContext']
    assert 'native button' not in startup['additionalContext']
    assert 'Validate request' not in startup['additionalContext']
    call = dict(tool_name='Bash', tool_input={'command': 'cat src/components/SaveButton.tsx'})
    selected = hook('PreToolUse', **call)
    assert selected['permissionDecision'] == 'deny'
    assert 'native button' in selected['additionalContext']
    assert 'Validate request' not in selected['additionalContext']
    assert not hook('PreToolUse', **call).get('additionalContext')
    hook('SessionEnd')
    shared = cli('sync')
    for name in RULES:
        assert (repo / '.claude/rules' / name).read_bytes() == (source / name).read_bytes()
    cli('check')
    evidence = {'init': initial, 'sync': shared, 'codex_only_init': True,
                'globals_at_startup': True, 'frontend_selected_backend_omitted': True,
                'first_call_suspended': True, 'retry_deduplicated': True,
                'optional_sharing_identical': True,
                'presentation': 'Illustrated IDE and Codex response. Real CLI and simulated hook payloads verified; live tests documented separately.'}
(WORK / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')

ui_path = os.environ.get('DEMO_UI_FONT', '/System/Library/Fonts/Helvetica.ttc')
mono_path = os.environ.get('DEMO_MONO_FONT', '/System/Library/Fonts/Menlo.ttc')
fonts = {}
def font(size, mono=False):
    key = (size, mono)
    if key not in fonts:
        fonts[key] = ImageFont.truetype(mono_path if mono else ui_path, size)
    return fonts[key]
BG, PANEL, EDITOR = '#0b111b', '#151c28', '#101722'
MUTED, TEXT, GREEN, BLUE = '#8291a7', '#e1e8f3', '#92e5b7', '#7fb4ff'

def frame(t):
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    def text(x, y, value, size=20, color=TEXT, mono=False):
        d.text((x, y), value, font=font(size, mono), fill=color)
    def line(x1, y1, x2, y2, c='#263243', width=1):
        d.line((x1, y1, x2, y2), fill=c, width=width)
    def folder(x, y, color=BLUE):
        d.rounded_rectangle((x, y+4, x+20, y+18), radius=2, fill=color)
        d.rectangle((x+1, y, x+9, y+7), fill=color)
    def file(x, y, color=MUTED):
        d.rounded_rectangle((x, y, x+15, y+19), radius=2, outline=color, width=1)
        line(x+4, y+6, x+11, y+6, color)
        line(x+4, y+11, x+11, y+11, color)
    def typed(x, y, value, start, rate=18, size=21):
        count = min(len(value), max(0, int((t-start)*rate)))
        text(x, y, value[:count], size, TEXT, True)
        if count < len(value) and int(t*2)%2 == 0:
            cx = x+d.textlength(value[:count], font=font(size, True))
            d.rectangle((cx+2, y+2, cx+12, y+24), fill=MUTED)
    text(58, 28, 'CODEX RULEBRIDGE', 22, GREEN)
    text(58, 62, 'The right rules. At the right time.', 30)
    text(1260, 37, 'ILLUSTRATED WORKFLOW', 15, MUTED)
    text(1240, 61, 'Codex response is illustrative', 16, MUTED)
    d.rounded_rectangle((42, 120, 1558, 866), radius=14, fill=PANEL, outline='#354155')
    d.rounded_rectangle((43, 121, 1557, 165), radius=13, fill='#202a38')
    d.rectangle((43, 150, 1557, 166), fill='#202a38')
    for x, color in [(67, '#ed6a63'), (89, '#eebd4e'), (111, '#62c655')]:
        d.ellipse((x, 137, x+12, 149), fill=color)
    text(600, 133, 'acme-dashboard  -  Visual Studio Code', 17, '#b7c4d7')
    d.rectangle((43, 167, 93, 835), fill='#111824')
    for y in [188, 248, 308, 368]:
        d.rounded_rectangle((59, y, 77, y+23), radius=3, outline=TEXT if y == 188 else MUTED, width=2)
    d.rectangle((43, 180, 46, 222), fill=BLUE)
    d.rectangle((94, 167, 439, 835), fill=PANEL)
    text(118, 185, 'EXPLORER', 15, MUTED)
    d.polygon([(112, 230), (122, 230), (117, 236)], fill=MUTED)
    text(132, 222, 'ACME-DASHBOARD', 17)
    selected = 'frontend.md' if t < 14 else 'general.md' if t < 21 else 'SaveButton.tsx'
    y = 266
    def row(label, depth=0, is_folder=False, highlight=False, color=TEXT):
        nonlocal y
        x = 114+depth*22
        if highlight:
            d.rectangle((95, y-5, 438, y+27), fill='#25364a')
        if is_folder:
            d.polygon([(x, y+8), (x+10, y+8), (x+5, y+14)], fill=MUTED)
            folder(x+18, y+1, BLUE if color == TEXT else color)
        else:
            file(x+18, y+1, color)
        text(x+46, y-1, label, 18, color)
        y += 34
    row('.agents', is_folder=True)
    row('rules', 1, True)
    for name in ['general.md', 'frontend.md', 'backend.md']:
        row(name, 2, highlight=name == selected, color=GREEN if (name == 'general.md' and t >= 17) or (name == 'frontend.md' and t >= 26) else TEXT)
    if t >= 10:
        row('.codex', is_folder=True, color=GREEN)
        row('hooks.json', 1, color=GREEN)
        row('rulebridge', 1, True)
    row('src', is_folder=True)
    row('components', 1, True)
    row('SaveButton.tsx', 2, highlight=selected == 'SaveButton.tsx')
    if t >= 43:
        row('.claude', is_folder=True, color=GREEN)
        row('rules', 1, True, color=GREEN)
        for name in ['general.md', 'frontend.md', 'backend.md']:
            row(name, 2, color=GREEN)
    line(439, 167, 439, 835)
    d.rectangle((440, 167, 1557, 575), fill=EDITOR)
    d.rectangle((440, 167, 780, 208), fill='#1d2939')
    file(458, 178, BLUE)
    text(482, 175, selected, 18)
    line(441, 207, 780, 207, BLUE, 2)
    breadcrumb = '.agents  ›  rules  ›  '+selected if selected.endswith('.md') else 'src  ›  components  ›  SaveButton.tsx'
    text(465, 220, breadcrumb, 17, MUTED)
    if selected == 'frontend.md':
        code = [(s, BLUE if s.startswith(('paths', '#')) else GREEN if 'button' in s else TEXT) for s in RULES['frontend.md'].splitlines()]
    elif selected == 'general.md':
        code = [(s, BLUE if s.startswith('#') else TEXT) for s in RULES['general.md'].splitlines()]
    else:
        code = [('export function SaveButton() {', BLUE), ('  return <div>Save</div>;', TEXT), ('}', BLUE)]
        if t >= 31:
            code = [('export function SaveButton() {', BLUE), ('  return (', TEXT), ('    <button type="button">', GREEN), ('      Save', TEXT), ('    </button>', GREEN), ('  );', TEXT), ('}', BLUE)]
    for i, (value, color) in enumerate(code):
        text(465, 260+i*29, str(i+1), 17, '#4b5b70', True)
        text(505, 260+i*29, value, 20, color, True)
    # Context indicator is a demo annotation, not a claimed native IDE feature.
    d.rounded_rectangle((1158, 256, 1533, 459), radius=12, fill='#172332', outline='#31435b')
    text(1178, 273, 'RULE LOADING  /  DEMO GUIDE', 14, MUTED)
    for yy, label, status, active in [(311, 'general.md', 'loaded' if t >= 17 else 'global', t >= 17),
                                    (354, 'frontend.md', 'loaded' if t >= 26 else 'on matching files', t >= 26),
                                    (397, 'backend.md', 'not needed' if t >= 26 else 'on matching files', False)]:
        text(1178, yy, label, 17, GREEN if active else TEXT)
        text(1178, yy+20, status, 14, GREEN if active else MUTED)
    d.rectangle((440, 576, 1557, 835), fill='#0d141e')
    line(440, 576, 1557, 576)
    text(465, 591, 'TERMINAL', 14)
    text(1400, 591, 'zsh    +', 16, MUTED)
    line(465, 615, 549, 615, BLUE, 2)
    if t < 14:
        text(466, 636, 'acme-dashboard  git:(main)', 20, GREEN, True)
        typed(466, 676, '› codex-rulebridge init', 4, 7)
        if t >= 9:
            text(466, 718, 'Configured 3 Codex rules with selective loading.', 20, GREEN, True)
        if t >= 11:
            text(466, 758, 'Review/trust the hooks in Codex (/hooks in CLI).', 19, MUTED, True)
    elif t < 21:
        text(466, 636, '› codex', 21, TEXT, True)
        text(466, 677, 'Review the generated project hooks', 22, BLUE)
        text(466, 715, 'Approve trusted hooks, then start a new session.', 20)
        if t >= 17:
            text(466, 759, 'Session starts: global conventions are available.', 21, GREEN)
            text(466, 798, 'Scoped rules wait until matching files are used.', 17, MUTED)
    elif t < 38:
        text(466, 632, 'CODEX', 15, GREEN)
        typed(466, 665, '› Make SaveButton a proper button.', 21.3, 15)
        if 25 <= t < 31:
            text(466, 708, 'Read  src/components/SaveButton.tsx', 20, TEXT, True)
        if 26 <= t < 31:
            text(466, 746, 'Matching frontend rule loaded before the read.', 21, GREEN)
            text(466, 785, 'First call suspended; Codex reviews the rule and retries.', 18, MUTED)
        if t >= 31:
            text(466, 708, 'Updated SaveButton.tsx', 21, GREEN)
            text(466, 745, 'Uses <button type="button"> as required by frontend.md.', 20)
            text(466, 784, 'No duplicate rule injection on subsequent calls.', 18, MUTED)
    else:
        text(466, 636, 'OPTIONAL  /  TEAM SHARING', 17, BLUE)
        typed(466, 676, '› codex-rulebridge sync', 39, 8)
        if t >= 43:
            text(466, 718, 'Synchronized 3 rules in both directions.', 20, GREEN, True)
            text(466, 758, '.agents/rules/  <->  .claude/rules/', 21, TEXT, True)
            text(466, 799, 'Same files. Same conventions. Run sync to share edits.', 17, MUTED)
    d.rectangle((43, 836, 1557, 854), fill='#223a57')
    text(60, 837, 'main', 12)
    text(1250, 837, 'UTF-8     Codex Rulebridge', 12)
    if t < 4:
        step, title, sub = '01', 'Organize your Codex rules by topic', 'Global conventions plus frontend and backend scopes in .agents/rules/.'
    elif t < 14:
        step, title, sub = '02', 'Set up Codex with one command', 'Local hooks are installed. Claude sharing is optional.'
    elif t < 21:
        step, title, sub = '03', 'Start with your global conventions', 'Review the hooks once. Review again when their commands change.'
    elif t < 31:
        step, title, sub = '04', 'Load frontend rules when they become relevant', 'A component read activates frontend.md. Backend guidance stays unloaded.'
    elif t < 38:
        step, title, sub = '05', 'Apply conventions without repeating them', 'The edit follows the loaded rule. Unchanged rules are not sent again.'
    else:
        step, title, sub = '06', 'Teammates use Claude? Share the same rules.', 'Optional bidirectional sync. Codex works on its own from the start.'
    d.rounded_rectangle((58, 897, 112, 951), radius=12, fill='#203e34')
    text(71, 909, step, 23, GREEN)
    text(133, 892, title, 26)
    text(133, 931, sub, 20, MUTED)
    d.rounded_rectangle((58, 978, 1542, 981), radius=1, fill='#233042')
    d.rounded_rectangle((58, 978, 58+1484*min(t/DURATION, 1), 981), radius=1, fill=GREEN)
    return im

ffmpeg = os.environ.get('FFMPEG')
if not ffmpeg:
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
command = [ffmpeg, '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(ASSETS / 'demo.mp4')]
# Log to a file to avoid a full stderr pipe blocking a long render.
with (WORK / 'ffmpeg.log').open('w') as log:
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log)
    try:
        for i in range(FPS*DURATION):
            process.stdin.write(frame(i/FPS).tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError('Video rendering failed; see work/video/ffmpeg.log')
    except Exception:
        process.kill()
        process.wait()
        raise
frame(33).save(ASSETS / 'demo-preview.png')
for t in [2, 11, 18, 27, 33, 45]:
    frame(t).save(WORK / f'new-frame-{t}.png')
print(f'Created {ASSETS / "demo.mp4"} ({DURATION}s, {W}x{H}, {FPS} fps)')
print(json.dumps(evidence, indent=2))
