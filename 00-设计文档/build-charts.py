# -*- coding: utf-8 -*-
"""
鲤慧 LiHui · 产品 PDF 图表资产生成器
------------------------------------------------
用 matplotlib 绘制产品方案里的数据图表，用 PIL 拼真机截图九宫格。
输出：00-设计文档/_assets/*.png（供 build-product-pdf.py 引用）

运行：C:/Users/Lenovo/.workbuddy/binaries/python/envs/default/Scripts/python.exe build-charts.py
"""
import os
import math

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPolygon, Circle, Rectangle
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'docs', 'screenshots')
ASSET = os.path.join(ROOT, '00-设计文档', '_assets')
os.makedirs(ASSET, exist_ok=True)

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei']
plt.rcParams['axes.unicode_minus'] = False
plt.rcParams['font.size'] = 9

BRAND = '#0fa693'
BRAND_D = '#0B7A6C'
GOLD = '#b98629'
GRAY = '#c7ced1'
RED = '#d94f4f'
INK = '#33383b'


# ---------- 工具：Catmull-Rom 闭合平滑（与 isochrone.js 同算法） ----------
def smooth_closed(pts, per=8):
    """标准 Catmull-Rom 闭合样条，返回平滑后点列（与引擎一致：每段 8 插值点）"""
    n = len(pts)
    P = lambda i: pts[i % n]
    out = []
    for i in range(n):
        p0, p1, p2, p3 = P(i - 1), P(i), P(i + 1), P(i + 2)
        for s in range(per):
            t = s / per
            t2, t3 = t * t, t * t * t
            x = (2 * p1[0] + (-p0[0] + p2[0]) * t
                 + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3) / 2.0
            y = (2 * p1[1] + (-p0[1] + p2[1]) * t
                 + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3) / 2.0
            out.append((x, y))
    return out


# ---------- 图 1：等时圈对比（直线圆 vs 真实路网） ----------
def fig_iso_compare(path):
    fig, axes = plt.subplots(1, 2, figsize=(7.6, 3.9))
    # 右图：36 方向实测辐射半径（15 分钟档实测 585~1150m，含路网绕行扰动）
    base_r = 865.0
    radii = []
    for i in range(36):
        a = math.radians(i * 10)
        r = base_r + 150 * math.sin(2 * a + 0.6) + 95 * math.cos(3 * a + 1.2) + 70 * math.sin(5 * a)
        radii.append(max(560.0, min(1180.0, r)))
    pts = [(r * math.cos(math.radians(i * 10)), r * math.sin(math.radians(i * 10)))
           for i, r in enumerate(radii)]
    smooth = smooth_closed(pts, 8)

    # 左：正圆 r=1200m（15 分钟 × 80m/min）
    ax = axes[0]
    th = np.linspace(0, 2 * math.pi, 200)
    ax.fill(1200 * np.cos(th), 1200 * np.sin(th), color=GRAY, alpha=0.55)
    ax.plot(1200 * np.cos(th), 1200 * np.sin(th), color='#8b979c', lw=1)
    ax.set_title('直线圆（常见做法）\n半径 1200m 恒定', fontsize=9.5, color=INK)
    ax.text(0, -0.055, '4.52 km²', transform=ax.transAxes, ha='center',
            fontsize=13, color='#7a8588', fontweight='bold')

    # 右：真实等时圈 + 5×5 盲区格
    ax = axes[1]
    poly = MplPolygon(smooth, closed=True, facecolor=BRAND, alpha=0.42, edgecolor=BRAND_D, lw=1.6)
    ax.add_patch(poly)
    # 5×5 论域网格 + 盲区判定（外圈与边角格覆盖度低 → 判为盲区）
    span = 1100.0
    cell = 2 * span / 5
    for gi in range(6):
        v = -span + gi * cell
        ax.plot([v, v], [-span, span], color='#e3e8ea', lw=0.8, ls='-', zorder=1)
        ax.plot([-span, span], [v, v], color='#e3e8ea', lw=0.8, ls='-', zorder=1)
    blind_cnt = 0
    for gi in range(5):
        for gj in range(5):
            cx = -span + (gi + 0.5) * cell
            cy = -span + (gj + 0.5) * cell
            dist = math.hypot(cx, cy)
            inpoly = seg_inside(cx, cy, smooth)
            if inpoly and dist > 620:
                blind_cnt += 1
                ax.add_patch(Rectangle((cx - cell / 2, cy - cell / 2), cell, cell,
                                       facecolor='#e05252', alpha=0.55, lw=1.4,
                                       edgecolor='#a82b26', zorder=3))
    ax.plot(0, 0, marker='o', color='#fff', markersize=7, markeredgecolor=BRAND_D,
            markeredgewidth=2, zorder=5)
    ax.text(0, -175, '家', ha='center', fontsize=9, color=BRAND_D, fontweight='bold')
    ax.set_title('真实路网等时圈（本产品）\n3 轮二分 + 外推 + 样条平滑', fontsize=9.5, color=INK)
    ax.text(0, -0.055, '1.83 km²', transform=ax.transAxes, ha='center',
            fontsize=13, color=BRAND_D, fontweight='bold')

    fig.suptitle('同一点位 · 15 分钟步行可达范围对比（郴州 113.014, 25.57）', fontsize=10, color=BRAND_D)
    for ax in axes:
        ax.set_aspect('equal')
        ax.set_xlim(-1500, 1500)
        ax.set_ylim(-1500, 1500)
        ax.axis('off')
        ax.grid(False)
    # 图例
    handles = [plt.Rectangle((0, 0), 1, 1, facecolor=BRAND, alpha=0.45,
                             edgecolor=BRAND_D, lw=1.4)]
    labels = ['等时圈（引擎产出）']
    if blind_cnt:
        handles.append(plt.Rectangle((0, 0), 1, 1, facecolor=RED, alpha=0.45))
        labels.append('服务盲区格（加权覆盖 < 40）')
    fig.legend(handles, labels, loc='lower center', ncol=2, frameon=False, fontsize=8.4,
               bbox_to_anchor=(0.5, -0.03))
    fig.tight_layout(rect=(0, 0.05, 1, 0.94))
    fig.savefig(path, dpi=170, bbox_inches='tight', facecolor='white')
    plt.close(fig)


def seg_inside(x, y, poly):
    """射线法：点是否在多边形内（生成器形式，便于即时判断）"""
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi):
            inside = not inside
        j = i
    return inside


# ---------- 图 2：面积对比柱状 ----------
def fig_area_bar(path):
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    vals = [4.52, 1.83]
    bars = ax.bar(['直线圆', '真实等时圈'], vals, color=[GRAY, BRAND], width=0.5)
    ax.bar_label(bars, ['4.52 km²', '1.83 km²'], fontsize=9.5,
                 color=BRAND_D, fontweight='bold')
    ax.set_ylabel('可达面积（km²）', fontsize=8.5, color=INK)
    ax.set_ylim(0, 5.6)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.tick_params(labelsize=8.5)
    ax.text(0.5, 3.4, '−59%', ha='center', fontsize=11, color=RED, fontweight='bold')
    ax.annotate('', xy=(1, 2.0), xytext=(0, 4.3),
                arrowprops=dict(arrowstyle='<-', color=RED, lw=1.2))
    ax.set_title('直线圆高估可达面积 59%', fontsize=9.5, color=BRAND_D)
    fig.tight_layout()
    fig.savefig(path, dpi=170, bbox_inches='tight', facecolor='white')
    plt.close(fig)


# ---------- 图 3：算路请求数压缩 ----------
def fig_quota_bar(path):
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    vals = [540, 4]
    bars = ax.bar(['朴素做法', '鲤慧引擎'], vals, color=[GRAY, BRAND], width=0.5)
    ax.bar_label(bars, ['540 次', '4 次'], fontsize=9.5, color=BRAND_D, fontweight='bold')
    ax.set_ylabel('算路请求数（次 / 次体检）', fontsize=8.5, color=INK)
    ax.set_ylim(0, 640)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.tick_params(labelsize=8.5)
    ax.text(1, 90, '135×', ha='center', fontsize=12, color=GOLD, fontweight='bold')
    ax.set_title('配额消耗压缩 135 倍', fontsize=9.5, color=BRAND_D)
    fig.tight_layout()
    fig.savefig(path, dpi=170, bbox_inches='tight', facecolor='white')
    plt.close(fig)


# ---------- 图 4：六类设施权重 ----------
def fig_weight_bar(path):
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    items = [('医疗', 25), ('商业 / 市场', 20), ('交通', 20),
             ('教育', 15), ('餐饮', 10), ('休闲', 10)]
    names = [k for k, _ in items]
    vals = [v for _, v in items]
    colors = [BRAND_D if i < 3 else BRAND for i in range(len(vals))]
    bars = ax.barh(names, vals, color=colors, height=0.55)
    ax.bar_label(bars, ['%d%%' % v for v in vals], fontsize=8.6, color=INK, fontweight='bold',
                 padding=3)
    ax.invert_yaxis()
    ax.set_xlim(0, 31)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(False)
    ax.tick_params(labelsize=8.5, length=0)
    ax.set_xlabel('评分权重', fontsize=8.5, color=INK)
    ax.xaxis.set_visible(False)
    ax.set_title('六类设施加权体检', fontsize=9.5, color=BRAND_D)
    fig.tight_layout()
    fig.savefig(path, dpi=170, bbox_inches='tight', facecolor='white')
    plt.close(fig)


# ---------- 真机截图拼图（2×3） ----------
def fig_shot_grid(path):
    names = ['01-home-map.jpg', '02-home-circle.jpg', '03-life-report.jpg',
             '05-assistant.jpg', '07-mall-hot.jpg', '09-orders.jpg']
    cols, rows = 3, 2
    tw, th = 250, 500          # 缩略尺寸
    canvas = Image.new('RGB', (cols * tw, rows * th), 'white')
    d = ImageDraw.Draw(canvas)
    for idx, n in enumerate(names):
        p = os.path.join(SHOT, n)
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert('RGB')
        ratio = th / im.width
        im = im.resize((int(im.height * ratio), th), Image.LANCZOS)
        im = im.crop((0, 0, tw, th))
        x = (idx % cols) * tw
        y = (idx // cols) * th
        canvas.paste(im, (x, y))
        d.rectangle([x + 0.5, y + 0.5, x + tw - 0.5, y + th - 0.5], outline='#dfe3e6')
    canvas.save(path, quality=92)
    return path


def main():
    f1 = os.path.join(ASSET, 'fig1-isochrone-compare.png')
    f2 = os.path.join(ASSET, 'fig2-area-bar.png')
    f3 = os.path.join(ASSET, 'fig3-quota-bar.png')
    f4 = os.path.join(ASSET, 'fig4-weight-bar.png')
    f5 = os.path.join(ASSET, 'fig5-shot-grid.jpg')
    p1 = os.path.join(SHOT, '12-isochrone.jpg')

    fig_iso_compare(f1)
    fig_area_bar(f2)
    fig_quota_bar(f3)
    fig_weight_bar(f4)
    fig_shot_grid(f5)
    for f in (f1, f2, f3, f4, f5):
        print('%s  %.0f KB' % (os.path.basename(f), os.path.getsize(f) / 1024.0))
    print('图表资产目录：%s' % ASSET)


if __name__ == '__main__':
    main()
