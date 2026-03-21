/**
 * Cloudflare Worker API - 图片分页服务（深度性能优化版）
 * 
 * 性能优化特性：
 * 1. Cloudflare Cache API 缓存高频页码（1-10页）
 * 2. KV 缓存图片索引数据
 * 3. 智能缓存策略：高频页面长缓存，低频页面短缓存
 * 4. 支持 ETag 和 Last-Modified 缓存验证
 * 5. 响应压缩优化
 * 
 * API 端点：
 * - GET /api/images?page=1&pageSize=20&category=wallpaper&subCategory=&search=
 * - GET /api/categories - 获取所有分类列表
 * - GET /api/stats - 获取统计信息
 */

// ==================== 性能配置 ====================
const CONFIG = {
  defaultPageSize: 20,
  maxPageSize: 100,
  
  // 缓存策略配置
  cache: {
    // 高频页码（1-10页）缓存时间（秒）
    hotPagesTtl: 7200,        // 2小时
    // 普通页码缓存时间
    normalPagesTtl: 1800,     // 30分钟
    // 搜索结果缓存时间（较短，因为变化多）
    searchResultsTtl: 300,    // 5分钟
    // 分类列表缓存时间
    categoriesTtl: 86400,     // 24小时
    // 统计信息缓存时间
    statsTtl: 3600,           // 1小时
    // 高频页码范围
    hotPageRange: 10,
  },
  
  // KV 缓存配置
  kv: {
    imageIndexTtl: 86400,     // 图片索引缓存24小时
    cacheKey: 'image-index-v2',
  },
};

// ==================== CORS 头 ====================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept-Encoding',
  'Access-Control-Max-Age': '86400',
};

// ==================== 缓存工具函数 ====================

/**
 * 生成缓存键
 */
function generateCacheKey(url) {
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * 判断是否为高频页码
 */
function isHotPage(page) {
  return page >= 1 && page <= CONFIG.cache.hotPageRange;
}

/**
 * 获取页面缓存 TTL
 */
function getPageCacheTtl(page, hasSearch) {
  if (hasSearch) {
    return CONFIG.cache.searchResultsTtl;
  }
  if (isHotPage(page)) {
    return CONFIG.cache.hotPagesTtl;
  }
  return CONFIG.cache.normalPagesTtl;
}

/**
 * 生成 ETag
 */
async function generateETag(data) {
  const str = JSON.stringify(data);
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  return `"${hashHex}"`;
}

/**
 * 尝试从 Cache API 获取缓存响应
 */
async function getFromCache(request) {
  const cache = caches.default;
  const cachedResponse = await cache.match(request);
  return cachedResponse;
}

/**
 * 存储响应到 Cache API
 */
async function putToCache(request, response) {
  const cache = caches.default;
  await cache.put(request, response.clone());
}

// ==================== 响应工具函数 ====================

/**
 * 返回 JSON 响应（带缓存头）
 */
function jsonResponse(data, status = 200, cacheOptions = {}) {
  const {
    maxAge = 3600,
    etag = null,
    isImmutable = false,
  } = cacheOptions;
  
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders,
  };
  
  // 缓存控制
  if (isImmutable) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = `public, max-age=${maxAge}, stale-while-revalidate=60`;
  }
  
  // ETag 支持
  if (etag) {
    headers['ETag'] = etag;
  }
  
  // CDN 缓存提示
  headers['CDN-Cache-Control'] = `public, max-age=${maxAge}`;
  headers['Cloudflare-CDN-Cache-Control'] = `public, max-age=${maxAge}`;
  
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * 返回错误响应
 */
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message, success: false }, status, { maxAge: 0 });
}

/**
 * 检查客户端缓存是否有效
 */
function isClientCacheValid(request, etag) {
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && etag) {
    return ifNoneMatch === etag || ifNoneMatch === '*';
  }
  return false;
}

/**
 * 返回 304 Not Modified
 */
function notModifiedResponse(etag) {
  return new Response(null, {
    status: 304,
    headers: {
      'ETag': etag,
      'Cache-Control': 'public, max-age=3600',
      ...corsHeaders,
    },
  });
}

// ==================== 图片处理工具 ====================

/**
 * 生成缩略图 URL
 * 支持多种图片 CDN 服务
 */
function generateThumbnailUrl(originalUrl, width = 400) {
  try {
    const url = new URL(originalUrl);
    
    // Cloudflare Images 格式
    if (url.hostname.includes('cloudflare') || url.hostname.includes('pages.dev')) {
      return `${originalUrl}?width=${width}&format=webp&quality=80`;
    }
    
    // 使用 wsrv.nl 图片缓存和缩放服务
    return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}&w=${width}&q=80&output=webp`;
  } catch (e) {
    return originalUrl;
  }
}

/**
 * 为图片添加缩略图 URL 和优化属性
 */
function enrichImages(images) {
  return images.map(img => ({
    ...img,
    thumbnail: generateThumbnailUrl(img.image, 400),
    thumbnailWebp: generateThumbnailUrl(img.image, 400),
    original: img.image,
    originalWebp: img.image.includes('?') 
      ? `${img.image}&format=webp` 
      : `${img.image}?format=webp`,
  }));
}

// ==================== 数据获取 ====================

/**
 * 从 KV 获取图片索引数据（带缓存）
 */
async function getImageIndex(env) {
  // 如果没有 KV 绑定，从静态文件获取
  if (!env.IMAGE_KV) {
    return await getImageIndexFromStatic(env);
  }
  
  try {
    const cached = await env.IMAGE_KV.get(CONFIG.kv.cacheKey, { type: 'json' });
    if (cached && cached.data && cached.timestamp) {
      // 检查缓存是否过期
      const age = Date.now() - cached.timestamp;
      if (age < CONFIG.kv.imageIndexTtl * 1000) {
        return cached.data;
      }
    }
    
    // 缓存过期或不存在，重新获取
    const data = await getImageIndexFromStatic(env);
    
    // 存储到 KV
    await env.IMAGE_KV.put(
      CONFIG.kv.cacheKey,
      JSON.stringify({ data, timestamp: Date.now() }),
      { expirationTtl: CONFIG.kv.imageIndexTtl }
    );
    
    return data;
  } catch (error) {
    console.error('KV 读取失败，降级到静态文件:', error);
    return await getImageIndexFromStatic(env);
  }
}

/**
 * 从静态文件获取图片索引
 */
async function getImageIndexFromStatic(env) {
  const baseUrl = env.SITE_URL || 'https://your-site.pages.dev';
  const response = await fetch(new URL('/data/image-index.json', baseUrl), {
    headers: {
      'Accept-Encoding': 'gzip, br',
    },
  });
  
  if (!response.ok) {
    throw new Error('无法获取图片索引');
  }
  
  return await response.json();
}

// ==================== 过滤和分页 ====================

/**
 * 过滤图片数据
 */
function filterImages(images, options) {
  const { category, subCategory, search } = options;
  
  return images.filter(img => {
    if (subCategory && img.category !== subCategory) {
      return false;
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      const titleMatch = img.title && img.title.toLowerCase().includes(searchLower);
      const categoryMatch = img.category && img.category.toLowerCase().includes(searchLower);
      if (!titleMatch && !categoryMatch) {
        return false;
      }
    }
    
    return true;
  });
}

/**
 * 分页处理
 */
function paginateImages(images, page, pageSize) {
  const total = images.length;
  const totalPages = Math.ceil(total / pageSize);
  const validPage = Math.max(1, Math.min(page, totalPages || 1));
  
  const startIndex = (validPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const pageImages = images.slice(startIndex, endIndex);
  
  return {
    images: pageImages,
    pagination: {
      currentPage: validPage,
      pageSize,
      totalImages: total,
      totalPages,
      hasNextPage: validPage < totalPages,
      hasPrevPage: validPage > 1,
    },
  };
}

// ==================== API 处理函数 ====================

/**
 * 处理图片列表请求（带缓存优化）
 */
async function handleImagesRequest(request, env, ctx) {
  const url = new URL(request.url);
  
  // 解析查询参数
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = Math.min(
    parseInt(url.searchParams.get('pageSize') || String(CONFIG.defaultPageSize), 10),
    CONFIG.maxPageSize
  );
  const category = url.searchParams.get('category') || '';
  const subCategory = url.searchParams.get('subCategory') || '';
  const search = url.searchParams.get('search') || '';
  const hasSearch = !!search;
  
  // 尝试从 Cache API 获取缓存（仅对无搜索请求缓存）
  if (!hasSearch) {
    const cacheKey = generateCacheKey(url);
    const cachedResponse = await getFromCache(cacheKey);
    
    if (cachedResponse) {
      // 检查客户端缓存
      const etag = cachedResponse.headers.get('ETag');
      if (etag && isClientCacheValid(request, etag)) {
        return notModifiedResponse(etag);
      }
      return cachedResponse;
    }
  }
  
  // 获取图片索引
  const index = await getImageIndex(env);
  
  // 处理分类
  let images = [];
  let categories = [];
  
  if (category && index.categories[category]) {
    images = index.categories[category].images;
    categories = [category];
  } else {
    categories = Object.keys(index.categories);
    images = categories.flatMap(cat => 
      index.categories[cat].images.map(img => ({ ...img, mainCategory: cat }))
    );
  }
  
  // 过滤和分页
  const filteredImages = filterImages(images, { category, subCategory, search });
  const paginatedResult = paginateImages(filteredImages, page, pageSize);
  const enrichedImages = enrichImages(paginatedResult.images);
  
  // 构建响应数据
  const responseData = {
    success: true,
    data: enrichedImages,
    pagination: paginatedResult.pagination,
    category: category || null,
    subCategory: subCategory || null,
    cached: false,
  };
  
  // 生成 ETag
  const etag = await generateETag(responseData);
  
  // 检查客户端缓存
  if (isClientCacheValid(request, etag)) {
    return notModifiedResponse(etag);
  }
  
  // 获取缓存 TTL
  const cacheTtl = getPageCacheTtl(page, hasSearch);
  
  // 构建响应
  const response = jsonResponse(responseData, 200, {
    maxAge: cacheTtl,
    etag,
    isImmutable: false,
  });
  
  // 缓存响应（仅缓存无搜索的请求）
  if (!hasSearch) {
    const cacheKey = generateCacheKey(url);
    ctx.waitUntil(putToCache(cacheKey, response.clone()));
  }
  
  return response;
}

/**
 * 处理分类列表请求（长缓存）
 */
async function handleCategoriesRequest(request, env, ctx) {
  // 尝试从缓存获取
  const url = new URL(request.url);
  const cacheKey = generateCacheKey(url);
  const cachedResponse = await getFromCache(cacheKey);
  
  if (cachedResponse) {
    const etag = cachedResponse.headers.get('ETag');
    if (etag && isClientCacheValid(request, etag)) {
      return notModifiedResponse(etag);
    }
    return cachedResponse;
  }
  
  const index = await getImageIndex(env);
  
  const categories = Object.entries(index.categories).map(([key, value]) => ({
    key,
    name: value.name,
    count: value.images.length,
    subCategories: value.subCategories || [],
  }));
  
  const responseData = {
    success: true,
    data: categories,
  };
  
  const etag = await generateETag(responseData);
  
  if (isClientCacheValid(request, etag)) {
    return notModifiedResponse(etag);
  }
  
  const response = jsonResponse(responseData, 200, {
    maxAge: CONFIG.cache.categoriesTtl,
    etag,
    isImmutable: false,
  });
  
  ctx.waitUntil(putToCache(cacheKey, response.clone()));
  
  return response;
}

/**
 * 处理统计信息请求
 */
async function handleStatsRequest(request, env, ctx) {
  const url = new URL(request.url);
  const cacheKey = generateCacheKey(url);
  const cachedResponse = await getFromCache(cacheKey);
  
  if (cachedResponse) {
    const etag = cachedResponse.headers.get('ETag');
    if (etag && isClientCacheValid(request, etag)) {
      return notModifiedResponse(etag);
    }
    return cachedResponse;
  }
  
  const index = await getImageIndex(env);
  
  const responseData = {
    success: true,
    data: index.stats,
  };
  
  const etag = await generateETag(responseData);
  
  if (isClientCacheValid(request, etag)) {
    return notModifiedResponse(etag);
  }
  
  const response = jsonResponse(responseData, 200, {
    maxAge: CONFIG.cache.statsTtl,
    etag,
  });
  
  ctx.waitUntil(putToCache(cacheKey, response.clone()));
  
  return response;
}

/**
 * 处理单个分类详情请求
 */
async function handleCategoryDetailRequest(request, env, categoryKey) {
  const index = await getImageIndex(env);
  
  if (!index.categories[categoryKey]) {
    return errorResponse('分类不存在', 404);
  }
  
  const category = index.categories[categoryKey];
  
  return jsonResponse({
    success: true,
    data: {
      key: categoryKey,
      name: category.name,
      count: category.images.length,
      subCategories: category.subCategories || [],
    },
  }, 200, { maxAge: CONFIG.cache.categoriesTtl });
}

// ==================== 主处理函数 ====================
export default {
  async fetch(request, env, ctx) {
    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204,
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=86400',
        }
      });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      // 路由处理
      if (path === '/api/images') {
        return await handleImagesRequest(request, env, ctx);
      }
      
      if (path === '/api/categories') {
        return await handleCategoriesRequest(request, env, ctx);
      }
      
      if (path === '/api/stats') {
        return await handleStatsRequest(request, env, ctx);
      }
      
      // 匹配 /api/category/:key
      const categoryMatch = path.match(/^\/api\/category\/([^/]+)$/);
      if (categoryMatch) {
        return await handleCategoryDetailRequest(request, env, categoryMatch[1]);
      }
      
      return errorResponse('接口不存在', 404);
      
    } catch (error) {
      console.error('处理请求失败:', error);
      return errorResponse('服务器内部错误: ' + error.message, 500);
    }
  },
};
