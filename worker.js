/**
 * Cloudflare Worker - Shopee Short Link Resolver
 * Deploy này lên Cloudflare Workers để xử lý short link
 */

// Cấu hình CORS
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

// Xử lý OPTIONS request (CORS preflight)
function handleOptions() {
    return new Response(null, { headers: corsHeaders });
}

// Extract shop_id và item_id từ URL
function extractProductIds(url) {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;

        // Pattern 1: /product/{shop_id}/{item_id}
        const productMatch = path.match(/\/product\/(\d+)\/(\d+)/);
        if (productMatch) {
            return { shopId: productMatch[1], itemId: productMatch[2] };
        }

        // Pattern 2: SEO URL ending with -i.{shop_id}.{item_id}
        const seoMatch = path.match(/-i\.(\d+)\.(\d+)/);
        if (seoMatch) {
            return { shopId: seoMatch[1], itemId: seoMatch[2] };
        }

        return null;
    } catch {
        return null;
    }
}

// Extract IDs từ HTML
function extractProductIdsFromHtml(html) {
    const patterns = [
        /"shopid"\s*:\s*(\d+).*?"itemid"\s*:\s*(\d+)/i,
        /"itemid"\s*:\s*(\d+).*?"shopid"\s*:\s*(\d+)/i,
        /\/product\/(\d+)\/(\d+)/,
        /-i\.(\d+)\.(\d+)/,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
            if (pattern.source.includes('itemid.*shopid')) {
                return { shopId: match[2], itemId: match[1] };
            }
            return { shopId: match[1], itemId: match[2] };
        }
    }

    return null;
}

// Extract URL từ HTML
function extractUrlFromHtml(html) {
    // og:url meta tag
    const ogUrlMatch = html.match(/property=["']og:url["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/content=["']([^"']+)["']\s+property=["']og:url["']/i);
    if (ogUrlMatch && ogUrlMatch[1].includes('shopee.vn')) {
        return ogUrlMatch[1];
    }

    // canonical link
    const canonicalMatch = html.match(/rel=["']canonical["']\s+href=["']([^"']+)["']/i) ||
                          html.match(/href=["']([^"']+)["']\s+rel=["']canonical["']/i);
    if (canonicalMatch && canonicalMatch[1].includes('shopee.vn')) {
        return canonicalMatch[1];
    }

    // product URL trong HTML
    const productUrlMatch = html.match(/https?:\/\/shopee\.vn\/[^\s"'<>]*-i\.\d+\.\d+/i) ||
                           html.match(/https?:\/\/shopee\.vn\/product\/\d+\/\d+/i);
    if (productUrlMatch) {
        return productUrlMatch[0];
    }

    return null;
}

// Resolve short link
async function resolveShortLink(shortUrl) {
    try {
        // Fetch với redirect: 'manual' để xem redirect chain
        let currentUrl = shortUrl;
        let maxRedirects = 5;

        while (maxRedirects > 0) {
            const response = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            // Nếu có redirect (301, 302, 307, 308)
            if ([301, 302, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (location) {
                    // Nếu location là relative URL
                    if (location.startsWith('/')) {
                        const urlObj = new URL(currentUrl);
                        currentUrl = urlObj.origin + location;
                    } else {
                        currentUrl = location;
                    }

                    // Kiểm tra xem đã đến shopee.vn chưa
                    if (currentUrl.includes('shopee.vn') && !currentUrl.includes('shp.ee')) {
                        const ids = extractProductIds(currentUrl);
                        if (ids) {
                            return {
                                success: true,
                                canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
                                shopId: ids.shopId,
                                itemId: ids.itemId
                            };
                        }
                    }
                    maxRedirects--;
                    continue;
                }
            }

            // Nếu là 200, đọc HTML và extract URL
            if (response.status === 200) {
                const html = await response.text();

                // Thử extract từ URL hiện tại
                let ids = extractProductIds(currentUrl);
                if (ids) {
                    return {
                        success: true,
                        canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
                        shopId: ids.shopId,
                        itemId: ids.itemId
                    };
                }

                // Thử extract từ HTML
                const foundUrl = extractUrlFromHtml(html);
                if (foundUrl) {
                    ids = extractProductIds(foundUrl);
                    if (ids) {
                        return {
                            success: true,
                            canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
                            shopId: ids.shopId,
                            itemId: ids.itemId
                        };
                    }
                }

                // Thử extract IDs trực tiếp từ HTML
                ids = extractProductIdsFromHtml(html);
                if (ids) {
                    return {
                        success: true,
                        canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
                        shopId: ids.shopId,
                        itemId: ids.itemId
                    };
                }
            }

            break;
        }

        return {
            success: false,
            error: 'Không thể resolve short link'
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// ==================== INSTAGRAM REDIRECT ====================
const AFFILIATE_ID = '17352620178';

// Generate random tracking id (giống uls_trackid / utm_term)
function generateTrackingId() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Lấy credential_token từ trang sản phẩm Shopee (nếu có)
async function fetchCredentialToken(productUrl) {
    try {
        const response = await fetch(productUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            redirect: 'follow'
        });

        if (!response.ok) return null;

        const html = await response.text();
        const credMatch = html.match(/"credential_token["\s:]+([a-zA-Z0-9_-]+)"/i) ||
                         html.match(/credential_token=([a-zA-Z0-9_-]+)/i);
        return credMatch ? credMatch[1] : null;
    } catch {
        return null;
    }
}

// Build Instagram redirect URL - gắn UTM params trực tiếp vào shopee.vn/product/...
// (giống cách Shopee Affiliate gắn tracking cho traffic ngoài, không qua an_redir
// để tránh việc app mở trang chủ trước rồi mới chuyển sang sản phẩm)
async function buildInstagramRedirectUrl(productUrl, affId, subId) {
    const affiliatePrefix = 'an_' + affId;

    const params = {
        mmp_pid: affiliatePrefix,
        utm_medium: 'affiliates',
        utm_source: affiliatePrefix,
        utm_content: subId,
        utm_campaign: '-',
        uls_trackid: generateTrackingId(),
        utm_term: generateTrackingId()
    };

    const credentialToken = await fetchCredentialToken(productUrl);
    if (credentialToken) {
        params.credential_token = credentialToken;
    }

    const url = new URL(productUrl);
    Object.keys(params).forEach(key => {
        url.searchParams.set(key, params[key]);
    });

    return url.toString();
}

// Handle Instagram redirect
async function handleInstagramRedirect(productUrl, affId, subId) {
    try {
        const redirectUrl = await buildInstagramRedirectUrl(productUrl, affId, subId);
        return Response.redirect(redirectUrl, 302);
    } catch {
        return Response.redirect(productUrl, 302);
    }
}

// ==================== MAIN HANDLER ====================

// Main handler
async function handleRequest(request) {
    const url = new URL(request.url);

    // Check if this is Instagram redirect request
    const goUrl = url.searchParams.get('go');
    const affType = url.searchParams.get('aff_type');
    const affId = url.searchParams.get('aff_id') || AFFILIATE_ID;
    const subId = url.searchParams.get('sub_id') || 'product----ig';

    if (goUrl && affType === 'instagram') {
        // Instagram redirect mode
        return handleInstagramRedirect(goUrl, affId, subId);
    }

    // Lấy URL cần xử lý từ query param (short link resolver mode)
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Missing url parameter'
        }), { headers: corsHeaders });
    }

    // Validate URL
    try {
        new URL(targetUrl);
    } catch {
        return new Response(JSON.stringify({
            success: false,
            error: 'Invalid URL'
        }), { headers: corsHeaders });
    }

    // Kiểm tra có phải Shopee URL không
    const urlObj = new URL(targetUrl);
    const host = urlObj.hostname.toLowerCase();
    const validHosts = ['shopee.vn', 'vn.shp.ee', 'shp.ee', 's.shopee.vn'];
    const isShopee = validHosts.some(h => host === h || host.endsWith('.' + h));

    if (!isShopee) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Not a Shopee URL'
        }), { headers: corsHeaders });
    }

    // Kiểm tra nếu đã là URL đầy đủ (không phải short link)
    const ids = extractProductIds(targetUrl);
    if (ids) {
        return new Response(JSON.stringify({
            success: true,
            canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
            shopId: ids.shopId,
            itemId: ids.itemId
        }), { headers: corsHeaders });
    }

    // Resolve short link
    const result = await resolveShortLink(targetUrl);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
}

// Event listener
addEventListener('fetch', event => {
    const request = event.request;

    if (request.method === 'OPTIONS') {
        event.respondWith(handleOptions());
    } else if (request.method === 'GET') {
        event.respondWith(handleRequest(request));
    } else {
        event.respondWith(new Response('Method not allowed', { status: 405 }));
    }
});
