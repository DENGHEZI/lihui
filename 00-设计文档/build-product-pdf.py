# -*- coding: utf-8 -*-
"""
鲤慧 LiHui · 产品与技术方案 PDF 生成器
------------------------------------------------
输入：README / 00-设计文档/07-等时圈与盲区算法设计.md / docs/screenshots/*
输出：00-设计文档/鲤慧LiHui-产品与技术方案.pdf

运行：C:/Users/Lenovo/.workbuddy/binaries/python/envs/default/Scripts/python.exe build-product-pdf.py
依赖：reportlab（已装于 default venv）
"""
import os
import glob
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
    Table, TableStyle, Image, PageBreak, KeepTogether, HRFlowable, NextPageTemplate,
)

# ============================== 基础配置 ==============================
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'docs', 'screenshots')
ASSET = os.path.join(ROOT, '00-设计文档', '_assets')
FONT_DIR = r'C:\Windows\Fonts'
OUT = os.path.join(ROOT, '00-设计文档', '鲤慧LiHui-产品与技术方案.pdf')

pdfmetrics.registerFont(TTFont('SimHei', os.path.join(FONT_DIR, 'simhei.ttf')))
pdfmetrics.registerFont(TTFont('MSYH', os.path.join(FONT_DIR, 'msyh.ttc'), subfontIndex=0))
pdfmetrics.registerFont(TTFont('MSYHBD', os.path.join(FONT_DIR, 'msyhbd.ttc'), subfontIndex=0))

C = {
    'brand':   colors.HexColor('#0fa693'),   # 主色 青绿
    'brandD':  colors.HexColor('#0B7A6C'),   # 主色深
    'gold':    colors.HexColor('#b98629'),   # 辅色 金
    'ink':     colors.HexColor('#22272a'),   # 正文（略柔，减少生硬）
    'ink2':    colors.HexColor('#5c6669'),   # 次级
    'ink3':    colors.HexColor('#8b9695'),   # 弱文字
    'gray':    colors.HexColor('#f7f9f9'),   # 浅底
    'line':    colors.HexColor('#e6eaec'),   # 分隔线（更细更淡）
    'accent':  colors.HexColor('#f2fafa'),   # 主色极浅底
    'hero':    colors.HexColor('#eef5f4'),   # 超大章节号底色
    'warn':    colors.HexColor('#c0392b'),   # 警示/负向
    'good':    colors.HexColor('#0fa693'),   # 正向
}
F = {'cn': 'MSYH', 'cnb': 'MSYHBD', 'mono': 'SimHei'}
PAGE_W, PAGE_H = A4
MARGIN_L = 1.9 * cm
MARGIN_R = 1.9 * cm
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

# ============================== 样式表 ==============================
def S(name, **kw):
    base = dict(fontName=F['cn'], fontSize=9.5, leading=15, textColor=C['ink'], alignment=TA_JUSTIFY)
    base.update(kw)
    return ParagraphStyle(name, **base)

ST = {
    'h1':  S('h1',  fontName=F['cnb'], fontSize=18, leading=25, textColor=C['ink'],
             alignment=TA_LEFT, spaceBefore=2, spaceAfter=2),
    'h1n': S('h1n', fontName=F['cnb'], fontSize=30, leading=30, textColor=C['hero']),
    'h1sub':S('h1sub', fontName=F['cn'], fontSize=8.6, leading=13, textColor=C['ink3'],
              spaceAfter=10),
    'h2':  S('h2',  fontName=F['cnb'], fontSize=12, leading=18, textColor=C['brandD'],
             alignment=TA_LEFT, spaceBefore=14, spaceAfter=5, leftIndent=8,
             borderPadding=(0, 0, 0, 4)),
    'h3':  S('h3',  fontName=F['cnb'], fontSize=10, leading=15, textColor=C['ink'],
             alignment=TA_LEFT, spaceBefore=10, spaceAfter=4),
    'p':   S('p',   fontSize=9.4, leading=16, spaceAfter=6),
    'pS':  S('pS',  fontSize=8.5, leading=14, textColor=C['ink2'], spaceAfter=5),
    'li':  S('li',  fontSize=9.3, leading=15.5, spaceAfter=4, leftIndent=12, bulletIndent=2),
    'code':S('code', fontName=F['mono'], fontSize=8.2, leading=13,
              textColor=colors.HexColor('#2b4a52'), leftIndent=0, spaceAfter=0),
    'cell':S('cell', fontSize=8.5, leading=13.5, alignment=TA_LEFT),
    'cellb':S('cellb', fontName=F['cnb'], fontSize=8.4, leading=13, alignment=TA_LEFT,
              textColor=C['brandD']),
    'cap': S('cap', fontSize=8, leading=11.5, textColor=C['ink2'], alignment=TA_CENTER, spaceAfter=8),
    'tt':  S('tt',  fontSize=8.6, leading=13.5, fontName=F['cnb'], textColor=C['brandD'], alignment=TA_CENTER),
    'big': S('big', fontName=F['cnb'], fontSize=19, leading=23, textColor=C['brand'],
             alignment=TA_CENTER),
    'bigw':S('bigw', fontName=F['cnb'], fontSize=19, leading=23, textColor=C['gold'],
             alignment=TA_CENTER),
    'bigr':S('bigr', fontName=F['cnb'], fontSize=19, leading=23, textColor=colors.HexColor('#c0392b'),
             alignment=TA_CENTER),
    'lab': S('lab', fontSize=7.8, leading=11, alignment=TA_CENTER, textColor=C['ink2']),
}

# ============================== 构造工具 ==============================
def P(t, s='p'):
    return Paragraph(t, ST[s])

def BULLET(items, style='li'):
    return [Paragraph(t, ST[style], bulletText=u'•') for t in items]

def CODE(lines):
    """代码块：极浅底 + 左侧主色竖条，不用边框"""
    body = '<br/>'.join(l.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                        .replace(' ', '&nbsp;') for l in lines)
    inner = [[Paragraph(body, ST['code'])]]
    t = Table(inner, colWidths=[CONTENT_W], hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), C['gray']),
        ('LINEBEFORE', (0, 0), (0, -1), 2.2, C['brand']),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return t

def TABLE(header, rows, widths=None, aligns=None, highlight_col=None, zebra=True):
    data = [[Paragraph(h, ST['cellb']) for h in header]]
    for r in rows:
        data.append([Paragraph(str(c), ST['cell']) for c in r])
    if widths is None:
        widths = [CONTENT_W / len(header)] * len(header)
    t = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    # 去网格：只留表头下方主色细线 + 行间极浅分隔线（轻盈，接近产品手册观感）
    cmds = [
        ('BACKGROUND', (0, 0), (-1, 0), colors.white),
        ('LINEBELOW', (0, 0), (-1, 0), 0.9, C['brand']),
        ('LINEBELOW', (0, 1), (-1, -1), 0.3, C['line']),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 6.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
    ]
    if zebra:
        for i in range(1, len(data)):
            if i % 2 == 0:
                cmds.append(('BACKGROUND', (0, i), (-1, i), colors.HexColor('#fbfdfd')))
    if highlight_col is not None:
        for i in range(1, len(data)):
            cmds.append(('TEXTCOLOR', (highlight_col, i), (highlight_col, i), C['brand']))
            cmds.append(('FONTNAME', (highlight_col, i), (highlight_col, i), F['cnb']))
    t.setStyle(TableStyle(cmds))
    return t

def SEC(num, title, sub=''):
    """章节头：超大浅色章节号 + 标题 + 金色细分隔线"""
    row = [[Paragraph(str(num), ST['h1n']), Paragraph(title, ST['h1'])]]
    t = Table(row, colWidths=[2.4 * cm, CONTENT_W - 2.4 * cm], hAlign='LEFT')
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
                           ('LEFTPADDING', (0, 0), (-1, -1), 0),
                           ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                           ('TOPPADDING', (0, 0), (-1, -1), 0),
                           ('BOTTOMPADDING', (0, 0), (-1, -1), 1)]))
    out = [t, HRFlowable(width='100%', thickness=1.2, color=C['gold'],
                         spaceBefore=2, spaceAfter=5)]
    out.append(Paragraph(sub, ST['h1sub']) if sub else Spacer(1, 3))
    return out

def STATCARD(items):
    """关键数字卡片：items = [(数字, 标签, 样式名), ...]"""
    n = len(items)
    rows = [[Paragraph('<b>%s</b>' % v, ST[s]) for v, l, s in items]]
    rows.append([Paragraph(l, ST['lab']) for v, l, s in items])
    t = Table(rows, colWidths=[CONTENT_W / n] * n, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, 0), 10), ('BOTTOMPADDING', (0, 1), (-1, 1), 9),
        ('TOPPADDING', (0, 1), (-1, 1), 1), ('BOTTOMPADDING', (0, 0), (-1, 0), 1),
        ('LINEABOVE', (0, 0), (-1, 0), 0.8, C['brand']),
        ('LINEBELOW', (0, 1), (-1, 1), 0.5, C['line']),
        ('LINEBEFORE', (1, 0), (-1, -1), 0.4, C['line']),
        ('BACKGROUND', (0, 0), (-1, -1), colors.white),
    ]))
    return t

def IMGSIDE(name_a, name_b, max_w=7.4 * cm, max_h=5.4 * cm, folder=None):
    """左右并排两张小图"""
    inner = [[IMG(name_a, max_w=max_w, max_h=max_h, folder=folder),
              IMG(name_b, max_w=max_w, max_h=max_h, folder=folder)]]
    t = Table(inner, colWidths=[CONTENT_W / 2] * 2, hAlign='LEFT')
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                           ('LEFTPADDING', (0, 0), (-1, -1), 0),
                           ('RIGHTPADDING', (0, 0), (-1, -1), 2)]))
    return t

def IMG(name, max_w=14.5 * cm, max_h=10.5 * cm, folder=None):
    """图片自适应：同时限制宽度与高度，竖屏手机截图也不会撑爆一页"""
    base = folder or SHOT
    path = os.path.join(base, name) if not os.path.isabs(name) else name
    if not os.path.exists(path) and folder:
        # 指定目录找不到时回落到真机截图目录（资产名与截图名混排时用）
        fallback = os.path.join(SHOT, name)
        if os.path.exists(fallback):
            path = fallback
    if not os.path.exists(path):
        return P('（图片缺失：%s）' % name, 'cap')
    im = Image(path)
    ratio = im.imageHeight / im.imageWidth
    w = min(max_w, CONTENT_W)
    h = w * ratio
    if h > max_h:                      # 先按高度收敛，再反算宽度
        h = max_h
        w = h / ratio
    w = min(w, CONTENT_W)
    im.drawWidth, im.drawHeight = w, h
    im.hAlign = 'CENTER'
    return im

def CAP(text):
    return Paragraph(text, ST['cap'])

def RULE():
    return HRFlowable(width='100%', thickness=1, color=C['line'], spaceBefore=4, spaceAfter=8)

def CALLOF(title, text, kind='info'):
    """提示框：极浅底 + 左侧竖条（主色/金色），无边框、无实色块"""
    bg = C['accent'] if kind == 'info' else colors.HexColor('#fbf5ea')
    bar = C['brand'] if kind == 'info' else C['gold']
    inner = [[Paragraph('<b>%s</b>　%s' % (title, text),
                        S('cal', fontSize=8.8, leading=14.5, leftIndent=0, spaceAfter=0))]]
    t = Table(inner, colWidths=[CONTENT_W], hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), bg),
        ('LINEBEFORE', (0, 0), (0, -1), 2.6, bar),
        ('LEFTPADDING', (0, 0), (-1, -1), 11),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    return t

# ============================== 页眉页脚 / 封面 ==============================
def on_page(canvas, doc):
    """页眉页脚：极细线 + 浅灰小字，克制不抢内容"""
    canvas.saveState()
    # 页眉：细主色短线（仅左侧一小段）+ 浅灰标识
    canvas.setStrokeColor(C['brand'])
    canvas.setLineWidth(0.9)
    canvas.line(MARGIN_L, PAGE_H - 1.35 * cm, MARGIN_L + 2.6 * cm, PAGE_H - 1.35 * cm)
    canvas.setStrokeColor(C['line'])
    canvas.setLineWidth(0.4)
    canvas.line(MARGIN_L + 2.6 * cm + 12, PAGE_H - 1.35 * cm, PAGE_W - MARGIN_R, PAGE_H - 1.35 * cm)
    canvas.setFont(F['cn'], 7.4)
    canvas.setFillColor(C['ink3'])
    canvas.drawString(MARGIN_L, PAGE_H - 1.18 * cm, '鲤慧 LiHui')
    canvas.drawRightString(PAGE_W - MARGIN_R, PAGE_H - 1.18 * cm, '产品与技术方案')
    # 页脚：细线 + 页码
    canvas.setStrokeColor(C['line'])
    canvas.setLineWidth(0.4)
    canvas.line(MARGIN_L, 1.5 * cm, PAGE_W - MARGIN_R, 1.5 * cm)
    canvas.setFont(F['cn'], 7.4)
    canvas.setFillColor(C['ink3'])
    canvas.drawString(MARGIN_L, 1.08 * cm, '基于百度地图开放能力 · 开源项目（MIT）')
    canvas.setFillColor(C['brand'])
    canvas.setFont(F['cnb'], 8)
    canvas.drawRightString(PAGE_W - MARGIN_R, 1.08 * cm, '%d' % canvas.getPageNumber())
    canvas.restoreState()

def draw_cover(canvas, doc):
    """封面：深色底 + 等时圈示意环 + 标题"""
    canvas.saveState()
    w, h = PAGE_W, PAGE_H
    canvas.setFillColor(colors.HexColor('#0B7A6C'))
    canvas.rect(0, 0, w, h, stroke=0, fill=1)
    # 等时圈示意：由外向内递进的同心环（不规则感用正弦扰动画弧）
    import math
    # 注意：canvas 坐标单位为 point，半径必须乘 cm 换算（1cm = 28.35pt）
    cx, cy = w * 0.5, h * 0.40
    rings = [(8.4 * cm, 0.13), (7.2 * cm, 0.20), (5.9 * cm, 0.29),
             (4.6 * cm, 0.40), (3.3 * cm, 0.53), (2.1 * cm, 0.66)]
    ELLIPSE_Y = 0.50          # 等时圈俯视压扁感
    for rad, alpha in rings:
        canvas.setStrokeColor(colors.white)
        canvas.setFillColor(colors.Color(1, 1, 1, alpha=alpha))
        canvas.setLineWidth(0.7)
        pth = canvas.beginPath()
        for i in range(0, 361, 6):
            a = math.radians(i)
            r = rad * (1 + 0.075 * math.sin(3 * a + 1.1) + 0.045 * math.cos(5 * a))
            x = cx + r * math.cos(a)
            y = cy + r * math.sin(a) * ELLIPSE_Y
            if i == 0:
                pth.moveTo(x, y)
            else:
                pth.lineTo(x, y)
        pth.close()
        canvas.drawPath(pth, stroke=1, fill=1)
    # 中心家点
    canvas.setFillColor(colors.white)
    canvas.circle(cx, cy, 0.34 * cm, stroke=0, fill=1)
    # 金环点缀
    canvas.setStrokeColor(C['gold'])
    canvas.setLineWidth(1.4)
    canvas.circle(cx, cy, 8.9 * cm, stroke=1, fill=0)
    # ---------- 文字层：标题在上半，等时圈环在下半（留白更从容） ----------
    canvas.setFillColor(colors.white)
    canvas.setFont(F['cnb'], 34)
    canvas.drawCentredString(w * 0.5, h * 0.795, '鲤慧 LiHui')
    canvas.setStrokeColor(C['gold'])
    canvas.setLineWidth(1.2)
    canvas.line(w * 0.5 - 2.4 * cm, h * 0.762, w * 0.5 + 2.4 * cm, h * 0.762)
    canvas.setFont(F['cn'], 12.2)
    canvas.drawCentredString(w * 0.5, h * 0.712, '基于百度地图开放能力的「15 分钟生活圈」智能体检与规划助手')
    canvas.setFont(F['cn'], 9.8)
    canvas.setFillColor(colors.Color(1, 1, 1, alpha=0.78))
    canvas.drawCentredString(w * 0.5, h * 0.668, '15 分钟，看清你的生活半径')
    # 徽章：细白描边胶囊（无填充），置于环上方深底区，对比清晰
    canvas.setFont(F['cnb'], 8.6)
    badges = ['4 端通吃', '零依赖服务端', '8 MCP Server', '65 API 路由', '真实路网等时圈']
    widths = [canvas.stringWidth(b, F['cnb'], 8.6) + 22 for b in badges]
    total = sum(widths) + 8 * (len(badges) - 1)
    x0 = (w - total) / 2
    for b, bw in zip(badges, widths):
        canvas.setStrokeColor(colors.Color(1, 1, 1, alpha=0.55))
        canvas.setLineWidth(0.7)
        canvas.roundRect(x0, h * 0.612, bw, 0.86 * cm, 0.43 * cm, stroke=1, fill=0)
        canvas.setFillColor(colors.white)
        canvas.drawCentredString(x0 + bw / 2, h * 0.612 + 0.29 * cm, b)
        x0 += bw + 8
    canvas.setFont(F['cn'], 8.3)
    canvas.setFillColor(colors.Color(1, 1, 1, alpha=0.72))
    canvas.drawCentredString(w * 0.5, h * 0.235,
                             '微信小程序 · 网页版 · Android / HarmonyOS / iOS——同一套后端，四种入口')
    canvas.drawCentredString(w * 0.5, h * 0.203,
                             '服务端纯 Node 内置模块零第三方依赖 · AK 不落端 · 能力可插拔 · 成本可核算')
    canvas.setFillColor(colors.white)
    canvas.setFont(F['cnb'], 9.6)
    canvas.drawCentredString(w * 0.5, 3.5 * cm, '2026 上海开源软件应用创新大赛 · 百度地图赛题')
    canvas.setFont(F['cn'], 8.6)
    canvas.setFillColor(colors.Color(1, 1, 1, alpha=0.72))
    canvas.drawCentredString(w * 0.5, 2.75 * cm, '开源仓库：Gitee deng-he-ziyan/lihui　|　GitHub DENGHEZI/lihui')
    canvas.drawCentredString(w * 0.5, 2.05 * cm, '文档版本 v1.0 · 2026-10-03')
    canvas.setFont(F['cn'], 7.8)
    canvas.setFillColor(colors.Color(1, 1, 1, alpha=0.6))
    canvas.drawCentredString(w * 0.5, 1.35 * cm, '本文档所有实测数据均来自真实百度地图 API 调用与真机运行')
    canvas.restoreState()

# ============================== 章节内容 ==============================
def build_story():
    st = []

    # ---------- 首页用封面模板（背景由 draw_cover 绘制），随后切正文模板 ----------
    st.append(NextPageTemplate('body'))
    st.append(PageBreak())

    # ---------- 目录 ----------
    st.append(P('目 录', 'h1'))
    st.append(RULE())
    toc = [
        ['01', '项目概述', '产品定位 · 三端入口 · 项目数据规格'],
        ['02', '核心产品功能', '生活圈体检 · 等时圈盲区 · 商城 · AI 助手 · 适老化'],
        ['03', '核心技术与实测：步行等时圈引擎', '算法设计 · 降级链 · 盲区口径 · 对比测试报告'],
        ['04', '其余创新点（2 — 9）', 'MCP 工具生态 · 坐标治理 · 可解释评分 · 零依赖 Web · 多端 APP'],
        ['05', '系统架构与工程规格', '三层架构 · 目录结构 · 技术选型'],
        ['06', '质量保障与开源规范', 'CI · 数学自测 · 安全治理 · 双端同步'],
        ['07', '快速开始与开源信息', '三步跑起来 · 开源协议 · 提交物清单'],
    ]
    st.append(TABLE(['#', '章节', '内容要点'], toc, widths=[1.3 * cm, 6.0 * cm, 9.7 * cm]))
    st.append(Spacer(1, 14))

    # ---------- 01 项目概述 ----------
    st.extend(SEC('01', '项目概述', '产品定位 · 三种入口 · 项目数据规格'))
    st.append(RULE())
    st.append(P('<b>鲤慧</b>是一套「<b>一码多端 + 服务端中转 + MCP 工具生态</b>」的地图智能助手：'
                '客户端只负责<b>呈现与采集</b>；百度地图能力、大模型调用、MCP 工具调度、Token 计量全部由服务端'
                '<b>统一中转</b>，从而做到三件事——<b>AK 不落端、能力可插拔、成本可核算</b>。'))
    st.append(P('围绕赛题核心「15 分钟生活圈」，鲤慧为每一类人群回答三个问题：'))
    st.extend(BULLET([
        '<b>我的生活圈缺什么？</b>——六类设施加权体检评分，短板可定位、分数可追因；',
        '<b>缺的东西去哪补？</b>——周边真实店源检索 + 路线规划；',
        '<b>补的过程谁帮我？</b>——AI 助手（MCP 工具编排）+ 语音交互。',
    ]))
    st.append(Spacer(1, 6))
    st.append(P('1.1　三种入口，同一套后端', 'h2'))
    st.append(TABLE(
        ['入口', '形态', '说明'],
        [['网页版', '浏览器直接打开', '自动定位 + IP 兜底 + 天气 + 生活圈体检 + 真实店源，零安装、扫码即用'],
         ['微信小程序', '微信扫一扫', '地图主页 / 商城 / 订单 / 模型与语音，全功能端'],
         ['多端 APP', 'Android / HarmonyOS / iOS', 'uni-app 工程，同一套 UI 规范']],
        widths=[2.6 * cm, 3.6 * cm, 10.8 * cm]))
    st.append(Spacer(1, 9))
    st.append(STATCARD([
        ('−59%', '直线圆高估可达面积（15 分钟档实测）', 'bigr'),
        ('135×', '算路配额压缩比（540 → 4 次/体检）', 'big'),
        ('4 次', '一次体检算路请求（实测）', 'big'),
        ('5.59 km²', '30 分钟档真实等时圈面积（真机扩展验证）', 'big'),
    ]))
    st.append(Spacer(1, 7))
    st.append(IMG('11-web-preview.png', max_w=15.5 * cm, max_h=14.0 * cm))
    st.append(CAP('图 1　网页版真机渲染：自动定位 → IP 兜底 → 天气 → 生活圈体检 → 真实店源'))
    st.append(Spacer(1, 4))
    st.append(P('1.2　项目数据规格', 'h2'))
    st.append(TABLE(
        ['维度', '数量'],
        [['端', '4（微信小程序 · 网页版 · Android · HarmonyOS/iOS）'],
         ['MCP Server', '8（16+ tools）'],
         ['API 路由', '65'],
         ['服务端依赖', '<b>0</b>（纯 Node 内置模块）'],
         ['等时圈引擎', '36 方向批量矩阵 · 3 轮二分收敛 · 一次体检仅 4 次算路请求'],
         ['设施类目', '6 类加权体检 + 8 类便民速查'],
         ['模型供应商', '6（OpenAI 兼容 / Anthropic / Gemini / Ollama / DeepSeek / 智谱）'],
         ['定位降级链', '4 级（端上 GPS → IP 锚定 → 逆地理补区 → 城市兜底）'],
         ['代码规模', '5 个独立工程包 · 近 100 个源文件（详见 05 章）']],
        widths=[4.0 * cm, 13.0 * cm]))
    st.append(Spacer(1, 5))
    st.append(P('关键实测口径：步速 80 m/min、路网弯曲系数 1.3、坐标统一 GCJ-02，'
                '在郴州 113.014, 25.57 实地点位验证——实测过程见 03 章。', 'pS'))

    st.append(PageBreak())

    # ---------- 02 核心产品功能 ----------
    st.extend(SEC('02', '核心产品功能', '生活圈体检 · 等时圈盲区 · 商城 · AI 助手 · 适老化'))
    st.append(RULE())
    st.append(IMG('fig5-shot-grid.jpg', max_w=16.2 * cm, max_h=13.0 * cm, folder=ASSET))
    st.append(CAP('图 2　真机功能一览：地图主页 · 生活圈 · 体检报告 · AI 助手 · 商城热门 · 订单'))
    st.append(Spacer(1, 6))
    st.append(P('2.1　生活圈体检：六类设施加权评分', 'h2'))
    st.append(P('不是拍脑袋给分：医疗 25% / 商业 20% / 交通 20% / 教育 15% / 餐饮 10% / 休闲 10%，'
                '权重写死在服务端；输出 = 环形总分 + 六类条形 + <b>短板一句话建议</b>。'))
    st.append(IMG('fig4-weight-bar.png', max_w=8.6 * cm, max_h=6.6 * cm, folder=ASSET))
    st.append(CAP('图 3　六类设施加权权重：医疗 25% / 商业 20% / 交通 20% / 教育 15% / 餐饮 10% / 休闲 10%'))
    st.append(Spacer(1, 4))
    st.append(P('2.2　步行等时圈与服务盲区（详见 03 章）', 'h2'))
    st.append(IMG('12-isochrone.jpg', max_w=8.2 * cm))
    st.append(CAP('图 4　小程序真机实测：等时圈边界 + 盲区格热区 + 四格指标 + 引擎徽章'))
    st.append(Spacer(1, 4))
    st.append(P('2.3　其他功能', 'h2'))
    st.append(TABLE(
        ['功能', '说明'],
        [['鲤慧商城', '店名 / 地址 / 电话全部来自百度 place 实时检索（非内置假数据）；'
                      '订单只留存记录并跳转第三方支付履约，<b>鲤慧不接触资金</b>'],
         ['AI 助手', '完整 MCP Client：意图 → tools/list 能力发现 → tools/call → 人性化回复 + 结构化卡片'],
         ['适老化关怀模式', '大字号 + WCAG AAA 高对比 + 慢速语音 + 单步引导 + 方言音色，语音引擎可换'],
         ['便民速查', '8 类便民服务（快递 / 银行 / 医院 / 药店 / 菜场 / 充电 / 公厕 / 停车场）'],
         ['语音交互', '录音 → 识别 → 播报（音色 / 语速 / 方言可配）'],
         ['Token 计量', '按模型与平台统计用量与配额，前端可见成本']],
        widths=[3.2 * cm, 13.8 * cm]))

    st.append(PageBreak())

    # ---------- 03 等时圈引擎（核心） ----------
    st.extend(SEC('03', '核心技术与实测：步行等时圈引擎', '算法设计 · 降级链 · 盲区口径 · 对比测试报告'))
    st.append(RULE())
    st.append(CALLOF('为什么是核心',
                     '赛题把「等时圈生成」设为 40% 权重的评分项，而最省事的画法是「以家为圆心画个正圆」。'
                     '鲤慧实测证明这种画法<b>系统性高估可达面积 59%</b>，因此本产品按百度官方推荐口径实现了完整引擎。'))

    st.append(IMG('fig1-isochrone-compare.png', max_w=16.4 * cm, max_h=9.8 * cm, folder=ASSET))
    st.append(CAP('图 5　同一点位、同一时间预算（15 分钟）下的可达范围对比：'
                  '左 = 直线圆；右 = 真实路网等时圈 + 5×5 网格盲区判定'))
    st.append(Spacer(1, 5))
    st.append(P('3.1　直线圆 vs 真实路网（同一点位，15 分钟）', 'h2'))
    st.append(TABLE(
        ['假设', '半径 1200m 正圆', '路网 + 实测 duration'],
        [['面积', '4.52 km²', '<b>1.83 km²（−59%）</b>'],
         ['可达半径', '1200 m（恒定）', '<b>585 ~ 1150 m（各向异）</b>']],
        widths=[3.4 * cm, 6.4 * cm, 7.2 * cm], highlight_col=2))
    st.append(CALLOF('结论',
                     '按真实路网，80 m/min 步速在城市中心因过街等待与支路绕行，有效直线半径仅约 <b>585~1150 m</b>；30 分钟档真机实测最远可达 1991 m。'
                     '直线圆会高估生活圈质量——这正是「等时圈」值得单独做一套引擎的原因。', 'warn'))

    st.append(P('3.2　算法总体流程', 'h2'))
    st.append(CODE([
        '36 方向扇形采样（10° 间隔）',
        '  → 每方向二分「最大可达步行距离」（每轮打包成一次 1×36 批量矩阵算路）',
        '  → 3 轮收敛 + 线性外推 est = probe.dist × budget / probe.duration',
        '  → Catmull-Rom 闭合样条平滑（每段 8 插值点 → 288 点）',
        '  → 5×5 网格盲区判定 → 候选盲区格二次矩阵实测复核',
    ]))
    st.append(P('参数全部按百度官方提示口径：步速 <b>80 m/min</b>、路网弯曲系数 <b>1.3</b>、坐标统一 <b>GCJ-02</b>。', 'pS'))

    st.append(IMGSIDE('fig2-area-bar.png', 'fig3-quota-bar.png',
                      max_w=7.8 * cm, max_h=6.0 * cm, folder=ASSET))
    st.append(CAP('图 6　可达面积对比（左）与单次体检算路请求数对比（右）'))
    st.append(Spacer(1, 5))
    st.append(P('3.3　硬核点', 'h2'))
    st.append(TABLE(
        ['硬核点', '实现'],
        [['批量矩阵压缩', '一次体检只烧 <b>4 次</b>算路请求（朴素做法 540 次），配额消耗压缩 <b>135 倍</b>；'
                          '3 端点候选（routematrix-batch → direction-concurrent → ideal-circle）自动择优'],
         ['降级链三级', '批量矩阵 → 并发单点算路（8 并发 + 令牌桶 130ms/令牌）→ 理想圆；'
                        '<b>engine 字段全链路可审计，降级不冒充</b>'],
         ['双配额池隔离', '实测发现算路与 place 检索配额池<b>互不共享</b> → 两套独立熔断器，'
                          '检索配额烧完的日子等时圈照样真算'],
         ['盲区口径可解释', '论域 = 圈内 N×N 格；格覆盖度 cov = max(0, 1 − walk/minutes)；'
                            '加权覆盖分 &lt; 40 判盲区；<b>分数与口径完全可复现</b>'],
         ['盲区二次复核', '候选盲区格再发一次 1×M 批量矩阵实测「家 → 格中心」，'
                          'duration &gt; budget×1.15 改判 outsideVerified，剔除插值偏乐观的格'],
         ['多源 POI 清洗', 'RRF 融合检索 → 逐关键词二次确认 → 坐标清洗 → 类间错峰 150ms，'
                           '单类异常只剔除该类并重新归一化，不影响其他类'],
         ['双端可视化', '网页版零依赖 SVG（等时圈 + 盲区热区 + 六轴雷达图 + 参考圈）；'
                        '小程序 map polygons 原生渲染（零 icon 依赖）']],
        widths=[3.4 * cm, 13.6 * cm]))

    st.append(P('3.4　API 深度：踩过的真实坑（2026-10 实测）', 'h2'))
    st.append(TABLE(
        ['踩坑点', '实测结论'],
        [['参数命名改版', '百度各产品线参数命名不统一：旧写法 <b>coord_type=3</b> 已全线报 '
                          '[coord_type] format is invalid；正确写法为 <b>coordtype=gcj02</b>（无下划线 + 字符串）'],
         ['返回结构差异', '矩阵端点返回 <b>{distance:{text,value}, duration:{text,value}}</b> 对象式，'
                          '而非数字；解析器做双形态兼容'],
         ['令牌桶死锁', '若每轮都重置时间戳，elapsed 恒为 0 → 令牌永不回流 → 并发任务全部挂死；'
                        '必须「只有真正累积令牌才推进时间戳」'],
         ['配额覆盖识别', 'place 超限返回 302 天配额超限，与算路配额互不连坐 → 拆成两个独立熔断开关']],
        widths=[3.0 * cm, 14.0 * cm]))

    st.append(P('3.5　实测报告与复现', 'h2'))
    st.append(TABLE(
        ['实测项', '结果'],
        [['点位', '郴州 113.014, 25.57（GCJ-02）'],
         ['引擎', 'routematrix-batch（rounds 3/3 收敛）'],
         ['耗时', '1.34 s / 次体检（15 分钟档实测）'],
         ['辐射半径', '585 ~ 1150 m（明显非圆）'],
         ['等时圈面积', '1.83 km²（15 分钟档）'],
         ['盲区复核', '候选格 100% 经矩阵实测复核，插值偏乐观格自动剔除'],
         ['30 分钟档（真机）', '面积 5.59 km² · 最远可达 1.991 km · 盲区格 14/14']],
        widths=[4.2 * cm, 12.8 * cm]))
    st.append(Spacer(1, 6))
    st.append(P('复现方式：', 'h3'))
    st.append(CODE([
        '# 等时圈（lng/lat 换成任意 GCJ-02 坐标）',
        'curl "http://127.0.0.1:8809/life/isochrone?lng=113.014&lat=25.57&minutes=15&grid=5"',
    ]))
    st.append(P('完整算法说明、API 调用策略与对比测试报告见仓库 <b>00-设计文档/07-等时圈与盲区算法设计.md</b>。', 'pS'))
    st.append(P('3.6　赛题评分项交付对照', 'h2'))
    st.append(TABLE(
        ['赛题评分项', '权重', '鲤慧交付'],
        [['功能正确性：等时圈生成', '40%',
          '36 方向扇形二分 + 3 轮收敛 + 线性外推 + Catmull-Rom 样条；盲区口径<b>可解释、可复现</b>；'
          '候选格 100% 经二次矩阵实测复核'],
         ['API 深度与调用效率', '30%',
          '1×36 批量矩阵算路；3 端点候选自动择优；8 并发 + 令牌桶限流；'
          '<b>双配额池隔离</b>；配额压缩 135 倍'],
         ['交互与可视化', '15%',
          '网页版零依赖 SVG（等时圈 + 盲区热区 + 六轴雷达图 + 参考圈）；'
          '小程序 map polygons 原生渲染；12 张真机截图佐证'],
         ['开源规范与工程质量', '15%',
          'GitHub Actions 双分支 5 步 CI；15 项数学自测（15/15 通过）；'
          '7 份设计文档；Gitee + GitHub 双仓同步；MIT 协议'],
         ['<b>合计</b>', '<b>100%</b>', '<b>全部交付并留可复现证据</b>']],
        widths=[3.6 * cm, 1.5 * cm, 11.9 * cm], highlight_col=1))

    st.append(PageBreak())

    # ---------- 04 其余创新点 ----------
    st.extend(SEC('04', '其余创新点（2 — 9）', 'MCP 工具生态 · 坐标治理 · 可解释评分 · 零依赖架构'))
    st.append(RULE())
    st.append(TABLE(
        ['#', '创新点', '要点'],
        [['2', '坐标统一治理（GCJ / WGS / BD-09 换算）',
          '网页版在前端内联把 WGS-84 定位换算成 GCJ-02 再打接口，与小程序 gcj02、百度返回值共用同一坐标系，'
          '避免「偏 500~900 米」；四级定位降级链保证任何环境都能拿到可用坐标'],
         ['3', '可解释的生活圈评分', '六类加权 + 短板一句话建议，分数可追因、可复现'],
         ['4', '网页版零依赖可视化',
          '原生 SVG 手绘等时圈 / 雷达图 / 参考圈，无任何图表库；服务端纯 Node 内置模块，装完即用'],
         ['5', '真实路网等时圈引擎', '（见 03 章，评分核心项 40%）'],
         ['6', 'Agent = 完整 MCP Client',
          '启动 → 拉起 8 个 MCP Server(stdio) → initialize → tools/list 能力发现 → tools/call；'
          '崩溃自动重启 ≤3 次'],
         ['7', '适老化关怀模式', '大字号 + WCAG AAA 高对比 + 慢速语音 + 单步引导 + 方言音色'],
         ['8', '第三方履约、鲤慧不碰资金', '订单只留存记录并跳转第三方平台完成支付履约，前端每次打免责说明'],
         ['9', '零依赖服务端架构', '纯 Node 内置模块（http/fs/path 等），无 npm 依赖，无容器也能跑']],
        widths=[0.9 * cm, 5.1 * cm, 11.0 * cm]))

    st.append(PageBreak())

    # ---------- 05 系统架构 ----------
    st.extend(SEC('05', '系统架构与工程规格', '三层架构 · 目录结构 · 技术选型'))
    st.append(RULE())
    st.append(CODE([
        '客户端层（只做呈现与采集）',
        '  01-lh-uniapp-多端APP (Android / HarmonyOS / iOS)   02-lh-wechat-mp (微信小程序)',
        '        |  <map> 底图渲染                    |  百度地图 AK 直连（小程序端）',
        '        |  语音采集/播报                     |  其余能力统一走服务端',
        '=================================== HTTPS (X-Device-Id / X-Plan) =============================',
        '                        03-lh-server（能力中转 + 编排）',
        '  /api/v1/ip/locate     自动锚定用户 IP → 城市/坐标/运营商',
        '  /api/v1/map/*         百度地图 Web 服务 API 代理（AK 仅存服务端）',
        '  /api/v1/agent/chat    Agent 编排：意图 → 工具 → 汇总 → 人性化回复',
        '  /api/v1/mcp/*         MCP Server 注册 / 启停',
        '  /api/v1/model/*       用户自定义模型与 API Key（6 类供应商）',
        '  /api/v1/voice/*       自定义语音（音色、语速、唤醒词、TTS）',
        '  /api/v1/token/*       Token 计量与配额',
        '=================================== MCP (JSON-RPC 2.0 over stdio) ==========================',
        '                    04-lh-mcp-servers（工具生态，即插即用）',
        '        baidu-map · life-circle · cost-optimizer · ip-anchor ·',
        '        desktop-action · emotion · voice · feedback',
    ]))
    st.append(Spacer(1, 6))
    st.append(P('5.1　目录结构', 'h2'))
    st.append(CODE([
        '鲤慧-LiHui/',
        '├── 00-设计文档/            # 产品与架构 · UI 规范 · 接口文档 · 部署指南 · 设计令牌',
        '├── 01-lh-uniapp-多端APP/   # uni-app 工程 → Android / HarmonyOS / iOS',
        '├── 02-lh-wechat-mp/        # 微信原生小程序工程',
        '├── 03-lh-server/           # Node.js 零依赖服务端（65 路由 + 等时圈引擎）',
        '├── 04-lh-mcp-servers/      # 8 个独立 MCP Server',
        '└── docs/screenshots/       # 真机截图（12 张）',
    ]))
    st.append(P('5 个包完全独立：各自拥有 package.json / manifest.json / project.config.json，'
                '无共享目录、无跨包相对引用，删掉任意一个包其余照常编译。', 'pS'))

    st.append(PageBreak())

    # ---------- 06 质量保障 ----------
    st.extend(SEC('06', '质量保障与开源规范', '持续集成 · 数学自测 · 安全治理 · 双仓同步'))
    st.append(RULE())
    st.append(TABLE(
        ['保障项', '做法与结果'],
        [['持续集成（CI）', 'GitHub Actions 5 步：全仓 JS 语法检查（自动发现新增文件）、数学自测、'
                            '模块图完整性、无 AK 冷启动冒烟、README/文档图片引用完整性——'
                            '<b>每次推送 master 与 main 双分支各跑一遍，当前全绿</b>'],
         ['数学自测', '15 项零依赖单元测试覆盖 haversine / 方向外推 / 射线法点在多边形 / '
                      'Catmull-Rom 插值与闭合性 / 多边形面积 / 官方口径常量——<b>15/15 通过</b>'],
         ['安全治理', '已清理误入库的运行时数据文件（含平台 API Key 落盘），补全 .gitignore；'
                      '服务端 AK 仅存 .env（已忽略），端上不可见；API 返回对密钥做脱敏'],
         ['可观测性', 'engine / degraded / quotaExhausted / hint 字段贯穿全链路，'
                      '任何降级与配额状态都能在响应里查到，不留静默失败'],
         ['双端同步', 'Gitee 与 GitHub 双仓发布，master 与 main 镜像一致，README 图片引用交叉可用']],
        widths=[3.2 * cm, 13.8 * cm]))
    st.append(Spacer(1, 6))
    st.append(CALLOF('工程原则',
                     '「静默失败」是这类地图产品最常见的坑：接口 200 但数据为空、字段读了错层级导致功能全废、'
                     '密钥落在不该落的文件里。鲤慧在每一层都加了<b>显式标记与可审计字段</b>，'
                     '让问题在响应里现形，而不是在用户眼前变成白屏。'))

    st.append(PageBreak())

    # ---------- 07 快速开始 ----------
    st.extend(SEC('07', '快速开始与开源信息', '三步跑起来 · 开源协议 · 提交物清单'))
    st.append(RULE())
    st.append(P('7.1　三步跑起来', 'h2'))
    st.append(CODE([
        '# ① 启动服务端（Node >= 18，零第三方依赖）',
        'cd 03-lh-server',
        'cp .env.example .env        # 填入你的百度地图服务端 AK',
        'node src/app.js             # → http://localhost:8809/',
        '',
        '# ② 微信小程序',
        '#   微信开发者工具 → 导入项目 → 目录选择 02-lh-wechat-mp/（必须精确到含 app.json 那一层）',
        '',
        '# ③ 等时圈体检（任意 GCJ-02 坐标）',
        'curl "http://127.0.0.1:8809/life/isochrone?lng=113.014&lat=25.57&minutes=15"',
    ]))
    st.append(P('7.2　开源协议与提交物', 'h2'))
    st.append(TABLE(
        ['项', '内容'],
        [['开源协议', 'MIT'],
         ['Gitee', 'https://gitee.com/deng-he-ziyan/lihui'],
         ['GitHub', 'https://github.com/DENGHEZI/lihui'],
         ['提交物', '5 个工程包（小程序 / uni-app / 服务端 / 8 MCP Server / 设计文档）+ '
                    '12 张真机截图 + 7 份设计文档（含等时圈算法与实测报告）+ CI 流水线']],
        widths=[3.0 * cm, 14.0 * cm]))
    st.append(Spacer(1, 10))
    st.append(CALLOF('一句话总结',
                     '鲤慧把「15 分钟生活圈」拆成了三件可验证的事：<b>用真实路网算准可达范围</b>（−59% 高估修正）、'
                     '<b>用可复现口径定位盲区</b>（网格加权 + 二次实测复核）、<b>用零依赖服务端把能力稳定送出去</b>'
                     '（135 倍配额压缩 + 三级降级 + 双端双仓）。'))

    return st

# ============================== 构建 ==============================
def main():
    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=MARGIN_L, rightMargin=MARGIN_R,
                          topMargin=2.2 * cm, bottomMargin=2.0 * cm,
                          title='鲤慧 LiHui · 产品与技术方案',
                          author='鲤慧 LiHui 团队', subject='15 分钟生活圈智能体检与规划助手')
    frame = Frame(MARGIN_L, 1.9 * cm, CONTENT_W, PAGE_H - 1.9 * cm - 2.5 * cm, id='body')
    doc.addPageTemplates([
        PageTemplate(id='cover', frames=[Frame(0, 0, PAGE_W, PAGE_H, id='cov')], onPage=draw_cover),
        PageTemplate(id='body', frames=[frame], onPage=on_page),
    ])
    story = build_story()
    # 首页用封面模板（背景在 draw_cover 里绘制），NextPageTemplate 之后切正文模板
    doc.build(story)
    if os.path.exists(OUT):
        print('PDF 生成成功：%s（%.1f KB）' % (OUT, os.path.getsize(OUT) / 1024.0))
    else:
        print('生成失败：未找到输出文件')

if __name__ == '__main__':
    main()
