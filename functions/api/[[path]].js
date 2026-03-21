/**
 * Cloudflare Pages Functions - 图片分页 API
 * 
 * 此文件处理所有 /api/* 请求
 * Pages Functions 使用 onRequest 导出格式
 */

// ==================== 性能配置 ====================
const CONFIG = {
  defaultPageSize: 20,
  maxPageSize: 100,
  cache: {
    hotPagesTtl: 7200,
    normalPagesTtl: 1800,
    searchResultsTtl: 300,
    categoriesTtl: 86400,
    statsTtl: 3600,
    hotPageRange: 10,
  },
  kv: {
    imageIndexTtl: 86400,
    cacheKey: 'image-index-v2',
  },
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept-Encoding',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200, cacheOptions = {}) {
  const { maxAge = 3600, etag = null } = cacheOptions;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders,
    'Cache-Control': `public, max-age=${maxAge}, stale-while-revalidate=60`,
    'CDN-Cache-Control': `public, max-age=${maxAge}`,
  };
  if (etag) headers['ETag'] = etag;
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message, success: false }, status, { maxAge: 0 });
}

function generateThumbnailUrl(originalUrl, width = 400) {
  try {
    const url = new URL(originalUrl);
    if (url.hostname.includes('cloudflare') || url.hostname.includes('pages.dev')) {
      return `${originalUrl}?width=${width}&format=webp&quality=80`;
    }
    return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}&w=${width}&q=80&output=webp`;
  } catch (e) {
    return originalUrl;
  }
}

function enrichImages(images) {
  return images.map(img => ({
    ...img,
    thumbnail: generateThumbnailUrl(img.image, 400),
    original: img.image,
  }));
}

async function getImageIndex(env) {
  if (!env.IMAGE_KV) {
    return await getImageIndexFromStatic(env);
  }
  try {
    const cached = await env.IMAGE_KV.get(CONFIG.kv.cacheKey, { type: 'json' });
    if (cached && cached.data && cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age < CONFIG.kv.imageIndexTtl * 1000) return cached.data;
    }
    const data = await getImageIndexFromStatic(env);
    await env.IMAGE_KV.put(CONFIG.kv.cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: CONFIG.kv.imageIndexTtl });
    return data;
  } catch (error) {
    return await getImageIndexFromStatic(env);
  }
}

async function getImageIndexFromStatic(env) {
  const baseUrl = env.SITE_URL || new URL('/data/image-index.json', 'https://image-gallery-cxr.pages.dev').origin;
  const response = await fetch(new URL('/data/image-index.json', baseUrl));
  if (!response.ok) throw new Error('无法获取图片索引');
  return await response.json();
}

function filterImages(images, options) {
  const { category, subCategory, search } = options;
  return images.filter(img => {
    if (subCategory && img.category !== subCategory) return false;
    if (search) {
      const searchLower = search.toLowerCase();
      const titleMatch = img.title && img.title.toLowerCase().includes(searchLower);
      const categoryMatch = img.category && img.category.toLowerCase().includes(searchLower);
      if (!titleMatch && !categoryMatch) return false;
    }
    return true;
  });
}

function paginateImages(images, page, pageSize) {
  const total = images.length;
  const totalPages = Math.ceil(total / pageSize);
  const validPage = Math.max(1, Math.min(page, totalPages || 1));
  const startIndex = (validPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  return {
    images: images.slice(startIndex, endIndex),
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

async function handleImagesRequest(request, env, context) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || String(CONFIG.defaultPageSize), 10), CONFIG.maxPageSize);
  const category = url.searchParams.get('category') || '';
  const subCategory = url.searchParams.get('subCategory') || '';
  const search = url.searchParams.get('search') || '';
  
  const index = await getImageIndex(env);
  let images = [];
  let categories = [];
  
  if (category && index.categories[category]) {
    images = index.categories[category].images;
    categories = [category];
  } else {
    categories = Object.keys(index.categories);
    images = categories.flatMap(cat => index.categories[cat].images.map(img => ({ ...img, mainCategory: cat })));
  }
  
  const filteredImages = filterImages(images, { category, subCategory, search });
  const paginatedResult = paginateImages(filteredImages, page, pageSize);
  const enrichedImages = enrichImages(paginatedResult.images);
  
  return jsonResponse({
    success: true,
    data: enrichedImages,
    pagination: paginatedResult.pagination,
    category: category || null,
    subCategory: subCategory || null,
  }, 200, { maxAge: search ? CONFIG.cache.searchResultsTtl : (page <= 10 ? CONFIG.cache.hotPagesTtl : CONFIG.cache.normalPagesTtl) });
}

async function handleCategoriesRequest(request, env, context) {
  const index = await getImageIndex(env);
  const categories = Object.entries(index.categories).map(([key, value]) => ({
    key,
    name: value.name,
    count: value.images.length,
    subCategories: value.subCategories || [],
  }));
  return jsonResponse({ success: true, data: categories }, 200, { maxAge: CONFIG.cache.categoriesTtl });
}

async function handleStatsRequest(request, env, context) {
  const index = await getImageIndex(env);
  return jsonResponse({ success: true, data: index.stats }, 200, { maxAge: CONFIG.cache.statsTtl });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=86400' } });
  }
  
  const url = new URL(request.url);
  const path = url.pathname;
  
  try {
    if (path === '/api/images') return await handleImagesRequest(request, env, context);
    if (path === '/api/categories') return await handleCategoriesRequest(request, env, context);
    if (path === '/api/stats') return await handleStatsRequest(request, env, context);
    
    const categoryMatch = path.match(/^\/api\/category\/([^/]+)$/);
    if (categoryMatch) {
      const index = await getImageIndex(env);
      if (!index.categories[categoryMatch[1]]) return errorResponse('分类不存在', 404);
      const category = index.categories[categoryMatch[1]];
      return jsonResponse({ success: true, data: { key: categoryMatch[1], name: category.name, count: category.images.length, subCategories: category.subCategories || [] } }, 200, { maxAge: CONFIG.cache.categoriesTtl });
    }
    
    return errorResponse('接口不存在', 404);
  } catch (error) {
    return errorResponse('服务器内部错误: ' + error.message, 500);
  }
}
