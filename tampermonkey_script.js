// ==UserScript==
// @name         快手Feed数据采集器-会话隔离版
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  修复URL匹配问题，支持完整路径，添加会话隔离
// @author       You
// @match        https://www.kuaishou.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      www.kuaishou.com
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 配置项
    const CONFIG = {
        autoStart: true,
        scrollDelay: 1000,
        maxScrollCount: 200,
        saveData: true,
        debug: true,
        scrollContainer: '.wb-content',
        scrollDistance: 1000,
        retryDelay: 2000,
        maxRetries: 3,
        stopOnNoMore: true,
        noMoreRetryCount: 3,
        // 新增：URL匹配配置
        feedUrlPatterns: [
            '/rest/v/profile/feed',
            '/profile/feed',
            '/feed'
        ],
        // 新增：会话管理配置
        maxSessions: 10,
        autoClearOldSessions: true
    };

    // 会话变量
    const SESSION_ID = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const PAGE_ID = window.location.pathname.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now().toString(36);

    // 状态变量
    let allFeedData = []; // 当前会话数据
    let allHistoricalData = []; // 所有历史数据（仅统计用）
    let scrollCount = 0;
    let isCollecting = false;
    let isPaused = false;
    let isStopping = false;
    let lastRequestTime = 0;
    let feedRequestCount = 0;
    let scrollContainer = null;
    let noMoreCount = 0;
    let hasMoreContent = true;
    let currentScrollPromise = null;

    // 添加控制面板
    function addControlPanel() {
        const panelHTML = `
            <div id="ks-collector-panel" style="
                position: fixed;
                top: 50%;
                right: 20px;
                transform: translateY(-50%);
                width: 380px;
                background: rgba(255, 255, 255, 0.98);
                border: 2px solid #FF6B00;
                border-radius: 12px;
                padding: 15px;
                z-index: 10000;
                box-shadow: 0 8px 32px rgba(255, 107, 0, 0.2);
                font-family: Arial, sans-serif;
                font-size: 12px;
                backdrop-filter: blur(10px);
            ">
                <div style="text-align: center; margin-bottom: 15px;">
                    <h3 style="margin: 0; color: #FF6B00; font-size: 14px;">
                        🎯 快手数据采集器 (会话隔离版)
                    </h3>
                    <div style="font-size: 10px; color: #666; margin-top: 3px; display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
                        <div>会话ID: ${SESSION_ID.substring(0, 8)}...</div>
                        <div>页面ID: ${PAGE_ID.substring(0, 12)}...</div>
                    </div>
                </div>

                <!-- 状态显示 -->
                <div style="
                    background: linear-gradient(45deg, #2196F3, #0D47A1);
                    border-radius: 8px;
                    padding: 12px;
                    color: white;
                    margin-bottom: 15px;
                ">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px;">
                        <div>
                            <span>滚动次数:</span>
                            <span id="ks-scroll-count" style="font-weight: bold;">0</span>
                        </div>
                        <div>
                            <span>数据量:</span>
                            <span id="ks-data-count" style="font-weight: bold;">0</span>
                            <span id="ks-total-data-count" style="font-size: 9px; opacity: 0.8;">(0累计)</span>
                        </div>
                        <div>
                            <span>请求匹配:</span>
                            <span id="ks-url-match-status" style="font-weight: bold; color: #4CAF50;">等待</span>
                        </div>
                        <div>
                            <span>最近URL:</span>
                            <span id="ks-last-url" style="font-weight: bold; font-size: 10px;">无</span>
                        </div>
                    </div>
                </div>

                <!-- 主要控制 -->
                <div style="margin-bottom: 15px;">
                    <button id="ks-start-btn" style="
                        width: 100%;
                        background: linear-gradient(45deg, #4CAF50, #2E7D32);
                        color: white;
                        border: none;
                        padding: 12px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 13px;
                        margin-bottom: 8px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                    ">
                        <span>▶</span> 开始采集
                    </button>

                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;">
                        <button id="ks-pause-btn" style="
                            background: linear-gradient(45deg, #FF9800, #F57C00);
                            color: white;
                            border: none;
                            padding: 8px;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 11px;
                        ">⏸️ 暂停</button>

                        <button id="ks-stop-btn" style="
                            background: linear-gradient(45deg, #f44336, #C62828);
                            color: white;
                            border: none;
                            padding: 8px;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 11px;
                        ">■ 停止</button>

                        <button id="ks-save-now" style="
                            background: linear-gradient(45deg, #9C27B0, #7B1FA2);
                            color: white;
                            border: none;
                            padding: 8px;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 11px;
                        ">💾 保存</button>
                    </div>
                </div>

                <!-- URL配置 -->
                <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 15px;">
                    <div style="margin-bottom: 10px;">
                        <div style="font-size: 11px; color: #666; margin-bottom: 5px;">URL匹配模式:</div>
                        <div id="ks-url-patterns" style="font-size: 10px; color: #2196F3; line-height: 1.4;">
                            ${CONFIG.feedUrlPatterns.map(pattern => `• ${pattern}`).join('<br>')}
                        </div>
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <button id="ks-test-urls" style="
                            background: linear-gradient(45deg, #00BCD4, #0097A7);
                            color: white;
                            border: none;
                            padding: 6px 12px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 10px;
                        ">测试URL匹配</button>

                        <span id="ks-url-match-count" style="font-size: 10px; color: #666; font-weight: bold;">
                            匹配: 0次
                        </span>
                    </div>
                </div>

                <!-- 数据操作 -->
                <div style="margin-bottom: 15px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <button id="ks-test-scroll" style="
                            background: linear-gradient(45deg, #9C27B0, #7B1FA2);
                            color: white;
                            border: none;
                            padding: 10px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-size: 12px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 6px;
                        ">
                            <span>🔄</span> 测试滚动
                        </button>

                        <button id="ks-download-btn" style="
                            background: linear-gradient(45deg, #2196F3, #1565C0);
                            color: white;
                            border: none;
                            padding: 10px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-size: 12px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 6px;
                        ">
                            <span>📥</span> 下载数据
                        </button>
                    </div>

                    <!-- 新增：会话管理按钮 -->
                    <button id="ks-view-history" style="
                        width: 100%;
                        background: linear-gradient(45deg, #607D8B, #455A64);
                        color: white;
                        border: none;
                        padding: 8px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 11px;
                        margin-top: 8px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                    ">
                        📚 查看历史会话
                    </button>

                    <div id="ks-history-panel" style="
                        display: none;
                        max-height: 200px;
                        overflow-y: auto;
                        background: #f5f5f5;
                        border-radius: 6px;
                        padding: 10px;
                        margin-top: 10px;
                        font-size: 10px;
                    "></div>
                </div>

                <!-- 配置 -->
                <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 15px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div>
                            <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">
                                滚动距离
                            </label>
                            <input type="number" id="ks-scroll-distance" value="${CONFIG.scrollDistance}" style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 11px;">
                        </div>

                        <div>
                            <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">
                                滚动间隔(ms)
                            </label>
                            <input type="number" id="ks-scroll-delay" value="${CONFIG.scrollDelay}" style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 11px;">
                        </div>
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <label style="font-size: 11px; color: #666; display: flex; align-items: center; gap: 5px;">
                            <input type="checkbox" id="ks-auto-start" ${CONFIG.autoStart ? 'checked' : ''}>
                            自动开始
                        </label>

                        <span id="ks-collecting-status" style="font-size: 10px; color: #666; font-weight: bold;">
                            状态: 等待
                        </span>
                    </div>
                </div>

                <!-- 日志 -->
                <div style="
                    max-height: 150px;
                    overflow-y: auto;
                    background: #1a1a1a;
                    color: #00ff00;
                    padding: 10px;
                    border-radius: 6px;
                    font-family: 'Courier New', monospace;
                    font-size: 10px;
                    line-height: 1.3;
                    margin-bottom: 12px;
                ">
                    <div id="ks-log">[系统] 等待初始化...</div>
                </div>

                <!-- 进度条 -->
                <div style="margin-top: 12px;">
                    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #666; margin-bottom: 4px;">
                        <span>采集进度</span>
                        <span id="ks-progress-text">0%</span>
                    </div>
                    <div style="width: 100%; height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden;">
                        <div id="ks-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4CAF50, #8BC34A); transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
        `;

        $('body').append(panelHTML);

        // 绑定事件
        $('#ks-start-btn').click(startCollecting);
        $('#ks-pause-btn').click(togglePause);
        $('#ks-stop-btn').click(safeStopCollecting);
        $('#ks-save-now').click(saveDataNow);
        $('#ks-test-scroll').click(testScroll);
        $('#ks-download-btn').click(downloadData);
        $('#ks-test-urls').click(testUrlMatching);
        $('#ks-view-history').click(showHistoryPanel);

        $('#ks-scroll-distance').change(function() {
            CONFIG.scrollDistance = Math.max(100, parseInt(this.value) || 800);
            GM_setValue('ks_config', JSON.stringify(CONFIG));
        });

        $('#ks-scroll-delay').change(function() {
            CONFIG.scrollDelay = Math.max(1000, parseInt(this.value) || 3000);
            GM_setValue('ks_config', JSON.stringify(CONFIG));
        });

        $('#ks-auto-start').change(function() {
            CONFIG.autoStart = this.checked;
            GM_setValue('ks_config', JSON.stringify(CONFIG));
        });

        // 添加拖拽功能
        makePanelDraggable();
    }

    // 加载会话数据
    function loadSessionData() {
        try {
            const storedData = GM_getValue('kuaishou_sessions', {});

            // 只加载历史数据用于统计
            const sessionKeys = Object.keys(storedData);
            allHistoricalData = [];

            if (sessionKeys.length > 0) {
                // 合并所有历史数据用于展示总数
                sessionKeys.forEach(key => {
                    if (storedData[key] && storedData[key].data) {
                        allHistoricalData = allHistoricalData.concat(storedData[key].data || []);
                    }
                });

                log(`加载历史数据: ${allHistoricalData.length} 条 (${sessionKeys.length} 个会话)`);
            }

            // 初始化当前会话为空数组
            allFeedData = [];
            feedRequestCount = 0;

            // 自动清理旧会话
            if (CONFIG.autoClearOldSessions && sessionKeys.length > CONFIG.maxSessions) {
                clearOldSessions();
            }

        } catch (e) {
            log('加载会话数据失败: ' + e.message);
            allFeedData = [];
            allHistoricalData = [];
        }
    }

    // 清理旧会话
    function clearOldSessions() {
        try {
            const sessions = GM_getValue('kuaishou_sessions', {});
            const sessionKeys = Object.keys(sessions);

            if (sessionKeys.length > CONFIG.maxSessions) {
                // 按时间排序，删除最旧的
                const sortedKeys = sessionKeys.sort((a, b) =>
                    new Date(sessions[a].timestamp) - new Date(sessions[b].timestamp)
                );

                const toDelete = sortedKeys.slice(0, sessionKeys.length - CONFIG.maxSessions);
                toDelete.forEach(key => {
                    delete sessions[key];
                });

                GM_setValue('kuaishou_sessions', sessions);
                log(`自动清理 ${toDelete.length} 个旧会话`);
            }
        } catch (e) {
            log('清理旧会话失败: ' + e.message);
        }
    }

    // URL匹配函数 - 修复版
    function isFeedUrl(url) {
        if (!url) return false;

        // 尝试多种匹配方式
        for (const pattern of CONFIG.feedUrlPatterns) {
            if (url.includes(pattern)) {
                return true;
            }
        }

        // 额外检查完整的URL格式
        const feedPatterns = [
            '/rest/v/profile/feed',
            '/rest/v1/profile/feed',
            '/rest/v2/profile/feed',
            '/api/v1/profile/feed',
            '/api/v2/profile/feed',
            '/graphql', // 有些可能是GraphQL接口
            '/profile/feed',
            '/feed'
        ];

        for (const pattern of feedPatterns) {
            if (url.includes(pattern)) {
                log(`发现新的feed URL模式: ${pattern}`);
                // 添加到配置中避免重复发现
                if (!CONFIG.feedUrlPatterns.includes(pattern)) {
                    CONFIG.feedUrlPatterns.push(pattern);
                    updateUrlPatternsDisplay();
                }
                return true;
            }
        }

        return false;
    }

    // 测试URL匹配
    function testUrlMatching() {
        log('🔍 测试URL匹配规则...');
        log(`当前匹配模式: ${CONFIG.feedUrlPatterns.join(', ')}`);

        // 测试各种URL
        const testUrls = [
            'https://www.kuaishou.com/rest/v/profile/feed',
            'https://www.kuaishou.com/rest/v/profile/feed?pcursor=123',
            '/rest/v/profile/feed',
            '/rest/v/profile/feed?pcursor=456',
            'https://api.kuaishou.com/rest/v/profile/feed',
            'https://api.kuaishou.com/rest/v1/profile/feed',
            'https://www.kuaishou.com/api/v2/profile/feed',
            'https://www.kuaishou.com/profile/feed',
            'https://www.kuaishou.com/feed',
            'https://www.kuaishou.com/rest/v/other/endpoint', // 这个应该不匹配
        ];

        testUrls.forEach(url => {
            const matches = isFeedUrl(url);
            log(`${matches ? '✅' : '❌'} ${url}`);
        });
    }

    // 更新URL模式显示
    function updateUrlPatternsDisplay() {
        $('#ks-url-patterns').html(CONFIG.feedUrlPatterns.map(pattern => `• ${pattern}`).join('<br>'));
    }

    // 更新URL匹配状态
    function updateUrlMatchStatus(status, color = '#666') {
        $('#ks-url-match-status').text(status).css('color', color);
    }

    // 更新最近URL显示
    function updateLastUrl(url) {
        if (!url) return;

        // 缩短URL显示
        let displayUrl = url;
        if (url.length > 30) {
            const parts = url.split('/');
            displayUrl = '.../' + parts.slice(-2).join('/');
        }

        $('#ks-last-url').text(displayUrl).attr('title', url);
    }

    // 更新URL匹配计数
    function updateUrlMatchCount() {
        $('#ks-url-match-count').text(`匹配: ${feedRequestCount}次`);
    }

    // 拦截网络请求（修复URL匹配）
    function interceptNetworkRequests() {
        log('🔍 启动请求拦截，配置URL匹配...');
        log(`URL匹配模式: ${CONFIG.feedUrlPatterns.join(', ')}`);

        // 拦截fetch
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            const [input, init] = args;
            let url = '';

            // 处理不同类型的input
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof Request) {
                url = input.url;
            } else if (input && input.url) {
                url = input.url;
            }

            // 检查URL是否匹配feed接口
            if (url && isFeedUrl(url)) {
                const requestId = Date.now();
                const startTime = Date.now();

                log(`📡 检测到feed请求: ${url}`);
                updateLastUrl(url);
                updateUrlMatchStatus('匹配成功', '#4CAF50');

                return originalFetch.apply(this, args).then(async response => {
                    const clonedResponse = response.clone();
                    const endTime = Date.now();
                    const duration = endTime - startTime;

                    try {
                        const data = await clonedResponse.json();

                        const feedData = {
                            id: requestId,
                            timestamp: new Date().toISOString(),
                            url: url,
                            fullUrl: input instanceof Request ? input.url : url,
                            method: init?.method || 'GET',
                            status: response.status,
                            duration: duration,
                            scrollCount: scrollCount,
                            scrollPosition: scrollContainer ? scrollContainer.scrollTop : null,
                            response: data
                        };

                        processFeedData(feedData);

                    } catch (e) {
                        log(`❌ 解析响应失败: ${e.message}`);

                        // 尝试获取文本内容
                        try {
                            const text = await clonedResponse.text();
                            log(`原始响应: ${text.substring(0, 100)}...`);
                        } catch (textError) {
                            log(`无法获取原始响应: ${textError.message}`);
                        }
                    }

                    return response;
                }).catch(error => {
                    log(`❌ 请求失败: ${error.message}`);
                    updateUrlMatchStatus('请求失败', '#f44336');
                    throw error;
                });
            }

            return originalFetch.apply(this, args);
        };

        // 拦截XHR
        const XHR = XMLHttpRequest.prototype;
        const originalOpen = XHR.open;
        const originalSend = XHR.send;

        XHR.open = function(method, url) {
            this._url = url;
            this._method = method;
            this._startTime = Date.now();

            if (url && isFeedUrl(url)) {
                log(`📡 检测到XHR feed请求: ${url}`);
                updateLastUrl(url);
                updateUrlMatchStatus('匹配成功', '#4CAF50');
            }

            return originalOpen.apply(this, arguments);
        };

        XHR.send = function(body) {
            this._requestBody = body;

            this.addEventListener('load', function() {
                const url = this._url;
                if (url && isFeedUrl(url)) {
                    const duration = Date.now() - this._startTime;

                    try {
                        const response = JSON.parse(this.responseText);

                        const feedData = {
                            timestamp: new Date().toISOString(),
                            url: url,
                            method: this._method,
                            status: this.status,
                            duration: duration,
                            scrollCount: scrollCount,
                            scrollPosition: scrollContainer ? scrollContainer.scrollTop : null,
                            response: response
                        };

                        processFeedData(feedData);

                    } catch (e) {
                        log(`❌ XHR解析失败: ${e.message}`);
                        updateUrlMatchStatus('解析失败', '#FF9800');
                    }
                }
            });

            this.addEventListener('error', function() {
                const url = this._url;
                if (url && isFeedUrl(url)) {
                    log(`❌ XHR请求失败: ${url}`);
                    updateUrlMatchStatus('请求失败', '#f44336');
                }
            });

            return originalSend.apply(this, arguments);
        };
    }

    // 处理feed数据
    function processFeedData(data) {
        if (isStopping) {
            log('正在停止中，跳过新数据');
            return;
        }

        feedRequestCount++;
        updateUrlMatchCount();

        // 检查是否需要停止
        if (data.response && checkShouldStop(data.response)) {
            if (isCollecting && !isStopping) {
                log('检测到停止条件，准备停止采集');
                setTimeout(() => safeStopCollecting(), 1000);
            }
        }

        allFeedData.push({
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            ...data
        });

        updateDataCount();

        // 显示信息
        if (data.response) {
            const urlInfo = data.url.length > 40 ? '...' + data.url.substring(data.url.length - 40) : data.url;

            if (data.response.pcursor) {
                const pcursor = data.response.pcursor;
                const dataCount = data.response.data ? data.response.data.length : 0;
                log(`📥 ${urlInfo}: ${dataCount}条, pcursor: "${pcursor}"`);
            } else if (data.response.result !== undefined) {
                log(`📥 ${urlInfo}: result=${data.response.result}`);
            } else {
                log(`📥 ${urlInfo}: 收到响应`);
            }
        }

        // 每收集10条数据保存一次
        if (allFeedData.length % 10 === 0 && !isStopping) {
            saveDataNow();
        }
    }

    // 下载数据（增强版，显示URL统计）
    function downloadData() {
        if (isStopping) {
            alert('正在停止采集过程中，请稍等几秒再下载');
            log('下载被阻止：正在停止过程中');
            return;
        }

        if (allFeedData.length === 0) {
            alert('⚠️ 当前会话没有数据可下载');
            return;
        }

        // 确保数据已保存到本地
        saveDataNow();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pageName = window.location.pathname.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `kuaishou_session_${pageName}_${SESSION_ID.substring(0, 8)}_${timestamp}.json`;

        // 统计信息（包含URL统计）
        const stats = {
            session_id: SESSION_ID,
            page_id: PAGE_ID,
            current_session: allFeedData.length,
            historical_total: allHistoricalData.length,
            total_sessions: Object.keys(GM_getValue('kuaishou_sessions', {})).length,
            no_more_count: allFeedData.filter(item =>
                item.response && item.response.pcursor === 'no_more'
            ).length,
            has_pcursor: allFeedData.filter(item =>
                item.response && item.response.pcursor
            ).length,
            success_count: allFeedData.filter(item =>
                item.response && item.response.data && item.response.data.length > 0
            ).length,
            // URL统计
            url_stats: {},
            url_patterns: CONFIG.feedUrlPatterns
        };

        // 统计不同URL的数量
        allFeedData.forEach(item => {
            const url = item.url || 'unknown';
            stats.url_stats[url] = (stats.url_stats[url] || 0) + 1;
        });

        const dataStr = JSON.stringify({
            meta: {
                exportTime: new Date().toISOString(),
                sessionId: SESSION_ID,
                pageId: PAGE_ID,
                pageUrl: window.location.href,
                currentSessionCount: allFeedData.length,
                historicalTotalCount: allHistoricalData.length,
                stats: stats,
                userAgent: navigator.userAgent,
                scrollContainer: CONFIG.scrollContainer,
                scrollCount: scrollCount,
                stopReason: getStopReason(),
                collectionDuration: getCollectionDuration(),
                urlPatterns: CONFIG.feedUrlPatterns
            },
            data: allFeedData
        }, null, 2);

        try {
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();

            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);

            log(`✅ 已下载当前会话 ${allFeedData.length} 条数据到 ${filename}`);
            log(`📊 累计总数据: ${allHistoricalData.length + allFeedData.length} 条`);

            // 显示URL统计
            const uniqueUrls = Object.keys(stats.url_stats).length;
            log(`📊 URL统计: ${uniqueUrls} 个唯一URL，${stats.success_count} 条成功响应`);

            // 显示最常访问的URL
            const topUrls = Object.entries(stats.url_stats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3);

            topUrls.forEach(([url, count], index) => {
                const shortUrl = url.length > 50 ? url.substring(0, 50) + '...' : url;
                log(`   ${index + 1}. ${shortUrl}: ${count}次`);
            });

            GM_notification({
                title: '下载完成',
                text: `已下载当前会话 ${allFeedData.length} 条数据`,
                timeout: 3000
            });

        } catch (error) {
            log(`❌ 下载失败: ${error.message}`);
            alert('下载失败，请检查控制台错误信息');
        }
    }

    // 安全停止采集
    function safeStopCollecting() {
        if (!isCollecting && !isStopping) {
            log('采集未运行，无需停止');
            return;
        }

        log('正在停止采集，请稍候...');
        updateCollectStatus('停止中', '#FF9800');

        isStopping = true;
        isCollecting = false;
        isPaused = false;

        setTimeout(() => {
            finalizeStop();
        }, 500);
    }

    // 最终完成停止
    function finalizeStop() {
        isStopping = false;
        updateCollectStatus('已停止', '#f44336');

        saveDataNow();

        log('✅ 采集已安全停止，数据已就绪可下载');

        GM_notification({
            title: '采集已停止',
            text: `已收集 ${allFeedData.length} 条数据，可以下载了`,
            timeout: 3000
        });
    }

    // 立即保存数据
    function saveDataNow() {
        if (allFeedData.length === 0) {
            log('暂无数据可保存');
            return;
        }

        try {
            // 保存到会话存储
            const sessionKey = `session_${SESSION_ID}_${PAGE_ID}`;
            const sessions = GM_getValue('kuaishou_sessions', {});

            sessions[sessionKey] = {
                timestamp: new Date().toISOString(),
                pageUrl: window.location.href,
                pageId: PAGE_ID,
                sessionId: SESSION_ID,
                scrollCount: scrollCount,
                dataCount: allFeedData.length,
                data: allFeedData
            };

            GM_setValue('kuaishou_sessions', sessions);
            log(`💾 已保存当前会话 ${allFeedData.length} 条数据到会话存储`);

        } catch (e) {
            log(`❌ 保存数据失败: ${e.message}`);
        }
    }

    // 开始采集
    function startCollecting() {
        if (isCollecting) {
            log('采集已在运行中');
            return;
        }

        if (isStopping) {
            log('正在停止中，请稍后再开始');
            return;
        }

        if (!hasMoreContent) {
            log('内容已加载完毕，请重置状态后再开始');
            return;
        }

        isCollecting = true;
        isStopping = false;
        isPaused = false;

        updateCollectStatus('采集中', '#4CAF50');
        log('🚀 开始采集数据...');

        if (scrollCount === 0) {
            noMoreCount = 0;
            hasMoreContent = true;
        }

        if (!findScrollContainer()) {
            log('❌ 无法开始：未找到滚动容器');
            isCollecting = false;
            updateCollectStatus('错误', '#f44336');
            return;
        }

        autoScrollLoop();
    }

    // 自动滚动循环
    async function autoScrollLoop() {
        if (!isCollecting || isPaused || isStopping) {
            log('采集循环被中断');
            return;
        }

        if (!hasMoreContent) {
            log('内容已加载完毕，停止采集');
            safeStopCollecting();
            return;
        }

        if (scrollCount >= CONFIG.maxScrollCount) {
            log(`✅ 达到最大滚动次数 ${CONFIG.maxScrollCount}`);
            safeStopCollecting();
            return;
        }

        try {
            currentScrollPromise = performScroll();
            const scrolled = await currentScrollPromise;
            currentScrollPromise = null;

            if (!scrolled) {
                log('滚动失败或已到底部');
                if (isCollecting && !isStopping) {
                    setTimeout(() => safeStopCollecting(), 1000);
                }
                return;
            }

            await delay(CONFIG.scrollDelay);

            if (isCollecting && !isPaused && !isStopping && hasMoreContent) {
                setTimeout(autoScrollLoop, 500);
            }

        } catch (error) {
            log(`❌ 滚动错误: ${error.message}`);
            currentScrollPromise = null;

            if (isCollecting && !isPaused && !isStopping && hasMoreContent) {
                setTimeout(autoScrollLoop, CONFIG.retryDelay);
            }
        }
    }

    // 检查是否应该停止采集
    function checkShouldStop(responseData) {
        if (!CONFIG.stopOnNoMore) return false;

        if (responseData && responseData.pcursor === 'no_more') {
            noMoreCount++;
            log(`检测到 pcursor="no_more" (连续第 ${noMoreCount} 次)`);

            if (noMoreCount >= CONFIG.noMoreRetryCount) {
                hasMoreContent = false;
                log(`连续 ${CONFIG.noMoreRetryCount} 次检测到 no_more，准备停止采集`);
                return true;
            }
        } else if (responseData && responseData.pcursor) {
            noMoreCount = 0;
        }

        return false;
    }

    // 其他辅助函数（保持不变）
    function findScrollContainer() {
        scrollContainer = document.querySelector(CONFIG.scrollContainer);

        if (!scrollContainer) {
            const possibleSelectors = [
                '.wb-content',
                '[class*="content"]',
                '[class*="main"]',
                '[class*="feed"]',
                '[class*="list"]',
                'main',
                '#app > div',
                'body > div:last-child'
            ];

            for (const selector of possibleSelectors) {
                const element = document.querySelector(selector);
                if (element && element.scrollHeight > element.clientHeight) {
                    scrollContainer = element;
                    log(`找到替代容器: ${selector}`);
                    break;
                }
            }
        }

        if (scrollContainer) {
            log(`✅ 找到滚动容器: ${scrollContainer.className || scrollContainer.tagName}`);
            return true;
        } else {
            log('❌ 未找到滚动容器');
            return false;
        }
    }

    // 测试滚动
    async function testScroll() {
        log('🔄 测试滚动功能...');

        try {
            const success = await performScroll();
            if (success) {
                log('✅ 滚动测试成功');
            } else {
                log('❌ 滚动测试失败');
            }
        } catch (error) {
            log(`❌ 测试错误: ${error.message}`);
        }
    }

    // 执行滚动
    async function performScroll() {
        if (!hasMoreContent) {
            log('⚠️ 已检测到页面底部，停止滚动');
            return false;
        }

        if (!scrollContainer) {
            if (!findScrollContainer()) {
                throw new Error('未找到滚动容器');
            }
        }

        const startPos = scrollContainer.scrollTop;
        const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;

        if (startPos >= maxScroll - 50) {
            log('已经滚动到容器底部');
            return false;
        }

        const targetPos = Math.min(startPos + CONFIG.scrollDistance, maxScroll);
        log(`滚动: ${startPos}px → ${targetPos}px`);

        scrollContainer.scrollTo({
            top: targetPos,
            behavior: 'smooth'
        });

        await delay(800);

        const endPos = scrollContainer.scrollTop;

        if (endPos > startPos) {
            log(`✅ 滚动成功: 移动了 ${endPos - startPos}px`);
            scrollCount++;
            updateScrollCount();
            updateProgress();
            return true;
        } else {
            log(`❌ 滚动失败: 位置未变化`);
            return false;
        }
    }

    // 暂停/恢复
    function togglePause() {
        if (!isCollecting) {
            log('采集未运行，无法暂停');
            return;
        }

        isPaused = !isPaused;
        if (isPaused) {
            log('⏸️ 采集已暂停');
            $('#ks-pause-btn').html('▶️ 恢复');
            updateCollectStatus('已暂停', '#FF9800');
        } else {
            log('▶️ 采集已恢复');
            $('#ks-pause-btn').html('⏸️ 暂停');
            updateCollectStatus('采集中', '#4CAF50');

            if (isCollecting && !isStopping) {
                setTimeout(autoScrollLoop, 500);
            }
        }
    }

    // 更新状态函数
    function updateCollectStatus(status, color = '#666') {
        $('#ks-collecting-status').text(`状态: ${status}`).css('color', color);
    }

    function updateScrollCount() {
        $('#ks-scroll-count').text(scrollCount);
    }

    function updateDataCount() {
        $('#ks-data-count').text(allFeedData.length);
        const totalCount = allHistoricalData.length + allFeedData.length;
        $('#ks-total-data-count').text(`(${totalCount}累计)`);
    }

    function updateProgress() {
        const progress = Math.min(100, (scrollCount / CONFIG.maxScrollCount) * 100);
        $('#ks-progress-bar').css('width', `${progress}%`);
        $('#ks-progress-text').text(`${Math.round(progress)}%`);
    }

    // 获取停止原因
    function getStopReason() {
        if (!isCollecting && !isStopping) {
            if (noMoreCount >= CONFIG.noMoreRetryCount) {
                return '检测到pcursor="no_more"';
            } else if (scrollCount >= CONFIG.maxScrollCount) {
                return '达到最大滚动次数';
            } else {
                return '手动停止';
            }
        }
        return '正在运行';
    }

    // 获取采集时长
    function getCollectionDuration() {
        if (allFeedData.length === 0) return '0秒';

        const firstTime = new Date(allFeedData[0].timestamp);
        const lastTime = new Date(allFeedData[allFeedData.length - 1].timestamp);
        const durationMs = lastTime - firstTime;

        const seconds = Math.floor(durationMs / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}小时${minutes % 60}分${seconds % 60}秒`;
        } else if (minutes > 0) {
            return `${minutes}分${seconds % 60}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    // 日志函数
    function log(message) {
        if (!CONFIG.debug) return;

        const timestamp = new Date().toLocaleTimeString();
        const logEntry = $(`
            <div style="margin: 2px 0; font-size: 9px;">
                <span style="color: #888;">[${timestamp}]</span> ${message}
            </div>
        `);

        $('#ks-log').prepend(logEntry);

        const logs = $('#ks-log').children();
        if (logs.length > 30) {
            logs.last().remove();
        }

        console.log('[快手采集]', message);
    }

    // 延迟函数
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 使面板可拖拽
    function makePanelDraggable() {
        const panel = $('#ks-collector-panel')[0];
        let isDragging = false;
        let offsetX, offsetY;

        panel.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;

            isDragging = true;
            offsetX = e.clientX - panel.getBoundingClientRect().left;
            offsetY = e.clientY - panel.getBoundingClientRect().top;
            panel.style.opacity = '0.9';
            panel.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            panel.style.left = (e.clientX - offsetX) + 'px';
            panel.style.top = (e.clientY - offsetY) + 'px';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panel.style.opacity = '1';
                panel.style.cursor = 'move';
            }
        });
    }

    // 显示历史会话面板
    function showHistoryPanel() {
        const historyPanel = $('#ks-history-panel');
        if (historyPanel.is(':visible')) {
            historyPanel.hide();
            return;
        }

        const sessions = GM_getValue('kuaishou_sessions', {});
        const sessionKeys = Object.keys(sessions);

        if (sessionKeys.length === 0) {
            historyPanel.html('<div style="color: #666; text-align: center; padding: 20px;">暂无历史会话数据</div>');
            historyPanel.show();
            return;
        }

        let html = '<div style="margin-bottom: 10px; font-weight: bold; color: #333;">历史会话:</div>';

        sessionKeys.sort((a, b) =>
            new Date(sessions[b].timestamp) - new Date(sessions[a].timestamp)
        ).forEach((key, index) => {
            const session = sessions[key];
            const time = new Date(session.timestamp).toLocaleString();
            const pageName = session.pageUrl ? new URL(session.pageUrl).pathname : '未知页面';
            const shortSessionId = session.sessionId ? session.sessionId.substring(0, 8) + '...' : '未知';

            html += `
                <div style="
                    background: white;
                    padding: 8px;
                    margin: 5px 0;
                    border-radius: 4px;
                    border-left: 3px solid #4CAF50;
                ">
                    <div><strong>${index + 1}. ${pageName}</strong></div>
                    <div style="color: #666; font-size: 9px;">时间: ${time}</div>
                    <div style="color: #666; font-size: 9px;">会话ID: ${shortSessionId}</div>
                    <div style="color: #666; font-size: 9px;">数据量: ${session.dataCount || 0} 条</div>
                    <div style="display: flex; gap: 5px; margin-top: 4px;">
                        <button onclick="unsafeWindow.downloadHistorySession('${key}')" style="
                            background: #2196F3;
                            color: white;
                            border: none;
                            padding: 4px 8px;
                            border-radius: 3px;
                            font-size: 8px;
                            cursor: pointer;
                            flex: 1;
                        ">
                            下载此会话
                        </button>
                        <button onclick="unsafeWindow.deleteHistorySession('${key}')" style="
                            background: #f44336;
                            color: white;
                            border: none;
                            padding: 4px 8px;
                            border-radius: 3px;
                            font-size: 8px;
                            cursor: pointer;
                            flex: 1;
                        ">
                            删除
                        </button>
                    </div>
                </div>
            `;
        });

        html += `
            <div style="margin-top: 10px; text-align: center;">
                <button onclick="unsafeWindow.clearAllSessions()" style="
                    background: #ff9800;
                    color: white;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 9px;
                ">
                    清空所有历史数据
                </button>
            </div>
        `;

        historyPanel.html(html).show();
    }

    // 下载历史会话
    function downloadHistorySession(sessionKey) {
        const sessions = GM_getValue('kuaishou_sessions', {});
        const session = sessions[sessionKey];

        if (!session || !session.data) {
            alert('会话数据不存在或已损坏');
            return;
        }

        const timestamp = new Date(session.timestamp).toISOString().replace(/[:.]/g, '-');
        const filename = `kuaishou_session_backup_${timestamp}.json`;

        const dataStr = JSON.stringify({
            meta: {
                exportTime: new Date().toISOString(),
                originalSessionTime: session.timestamp,
                sessionId: session.sessionId,
                pageUrl: session.pageUrl,
                dataCount: session.dataCount,
                scrollCount: session.scrollCount
            },
            data: session.data
        }, null, 2);

        try {
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);

            log(`已下载历史会话: ${session.dataCount || 0} 条数据`);
        } catch (error) {
            log(`下载历史会话失败: ${error.message}`);
            alert('下载失败');
        }
    }

    // 删除历史会话
    function deleteHistorySession(sessionKey) {
        if (!confirm('确定要删除这个会话的数据吗？')) return;

        const sessions = GM_getValue('kuaishou_sessions', {});
        const session = sessions[sessionKey];
        const dataCount = session ? (session.dataCount || 0) : 0;

        delete sessions[sessionKey];
        GM_setValue('kuaishou_sessions', sessions);

        // 更新历史数据统计
        loadSessionData();
        updateDataCount();

        log(`已删除会话: ${sessionKey} (${dataCount}条数据)`);
        showHistoryPanel(); // 刷新显示
    }

    // 清空所有历史数据
    function clearAllSessions() {
        if (!confirm('确定要清空所有历史会话数据吗？此操作不可恢复！')) return;

        GM_setValue('kuaishou_sessions', {});
        allHistoricalData = [];
        updateDataCount();

        log('已清空所有历史会话数据');
        $('#ks-history-panel').hide();
    }

    // 将函数暴露到全局，供按钮调用
    unsafeWindow.downloadHistorySession = downloadHistorySession;
    unsafeWindow.deleteHistorySession = deleteHistorySession;
    unsafeWindow.clearAllSessions = clearAllSessions;

    // 初始化
    function init() {
        try {
            const savedConfig = GM_getValue('ks_config');
            if (savedConfig) {
                Object.assign(CONFIG, JSON.parse(savedConfig));
            }
        } catch (e) {
            log('加载配置失败: ' + e.message);
        }

        // 加载会话数据（而不是所有数据）
        loadSessionData();

        interceptNetworkRequests();

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => {
                    addControlPanel();
                    findScrollContainer();
                    updateDataCount();
                    updateUrlMatchCount();
                    log('会话隔离版脚本初始化完成');
                    log(`当前会话ID: ${SESSION_ID}`);
                    log(`页面ID: ${PAGE_ID}`);
                    log(`URL匹配模式: ${CONFIG.feedUrlPatterns.join(', ')}`);

                    if (CONFIG.autoStart) {
                        setTimeout(() => startCollecting(), 2000);
                    }
                }, 1500);
            });
        } else {
            setTimeout(() => {
                addControlPanel();
                findScrollContainer();
                updateDataCount();
                updateUrlMatchCount();
                log('会话隔离版脚本初始化完成');
                log(`当前会话ID: ${SESSION_ID}`);
                log(`页面ID: ${PAGE_ID}`);
                log(`URL匹配模式: ${CONFIG.feedUrlPatterns.join(', ')}`);

                if (CONFIG.autoStart) {
                    setTimeout(() => startCollecting(), 2000);
                }
            }, 1500);
        }
    }

    // 启动
    init();
})();
