/**
 * 图片索引生成脚本
 * 功能：扫描所有分类目录，生成图片索引 JSON 文件
 * 用途：为静态网站提供预生成的图片数据，避免运行时 API 调用
 * 运行：node scripts/generate-index.js
 */

const fs = require('fs');
const path = require('path');

// 配置项
const CONFIG = {
  // 需要扫描的分类目录（以 _ 开头）
  categoriesDir: __dirname + '/..',
  // 输出文件路径
  outputFile: __dirname + '/../data/image-index.json',
  // 支持的图片格式
  imageExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
  // 分类名称映射（默认值，会被 README.md 中的标题覆盖）
  categoryNames: {
    'wallpaper': '高清壁纸',
    'avatar': '个性头像',
    'people': '人物',
    'scenery': '风景',
    'wei-mei-zhi-yu': '唯美治愈',
    'dong-man-cha-hua': '动漫插画',
    'wen-zi-yu-lu': '文字语录',
    'ying-shi-ming-xing': '影视明星',
    'bei-jing-su-cai': '背景素材'
  }
};

/**
 * 解析 Markdown 文件的 front matter
 * @param {string} content - Markdown 文件内容
 * @returns {object} 解析后的数据对象
 */
function parseFrontMatter(content) {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontMatterRegex);
  
  if (!match) {
    return {};
  }
  
  const frontMatter = match[1];
  const data = {};
  
  // 解析 YAML 格式的 front matter
  frontMatter.split('\n').forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();
      
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      data[key] = value;
    }
  });
  
  return data;
}

/**
 * 从 README.md 获取分类名称
 * @param {string} dirPath - 分类目录路径
 * @returns {string|null} 分类名称
 */
function getCategoryName(dirPath) {
  const readmePath = path.join(dirPath, 'README.md');
  
  if (fs.existsSync(readmePath)) {
    try {
      const content = fs.readFileSync(readmePath, 'utf-8');
      const titleMatch = content.match(/^#\s*(.+)$/m);
      if (titleMatch) {
        return titleMatch[1].trim();
      }
    } catch (e) {
      console.warn(`读取 README.md 失败: ${readmePath}`);
    }
  }
  
  return null;
}

/**
 * 扫描单个分类目录
 * @param {string} categoryDir - 分类目录路径
 * @param {string} categoryKey - 分类键名
 * @returns {object} 分类数据
 */
function scanCategory(categoryDir, categoryKey) {
  const images = [];
  const subCategories = new Set();
  
  if (!fs.existsSync(categoryDir)) {
    console.warn(`目录不存在: ${categoryDir}`);
    return { images, subCategories: [] };
  }
  
  // 递归扫描目录
  function scanDirectory(dir, subCategory = null) {
    const items = fs.readdirSync(dir);
    
    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory()) {
        // 如果是子目录，作为子分类处理
        const subCatName = item;
        scanDirectory(itemPath, subCatName);
      } else if (item.endsWith('.md') && item !== 'README.md') {
        // 解析 Markdown 文件
        try {
          const content = fs.readFileSync(itemPath, 'utf-8');
          const data = parseFrontMatter(content);
          
          if (data.image) {
            // 记录子分类
            const cat = data.category || subCategory;
            if (cat) {
              subCategories.add(cat);
            }
            
            images.push({
              title: data.title || '',
              image: data.image,
              category: cat || '未分类',
              fileName: item
            });
          }
        } catch (e) {
          console.warn(`解析文件失败: ${itemPath}`);
        }
      }
    });
  }
  
  scanDirectory(categoryDir);
  
  return {
    images,
    subCategories: Array.from(subCategories)
  };
}

/**
 * 主函数：生成图片索引
 */
function generateIndex() {
  console.log('开始生成图片索引...');
  console.log('扫描目录:', CONFIG.categoriesDir);
  
  const index = {
    version: new Date().toISOString().split('T')[0],
    generated: new Date().toISOString(),
    categories: {},
    stats: {
      totalImages: 0,
      totalCategories: 0
    }
  };
  
  // 获取所有以 _ 开头的目录
  const items = fs.readdirSync(CONFIG.categoriesDir);
  const categoryDirs = items.filter(item => {
    const itemPath = path.join(CONFIG.categoriesDir, item);
    return item.startsWith('_') && fs.statSync(itemPath).isDirectory();
  });
  
  console.log(`发现 ${categoryDirs.length} 个分类目录`);
  
  // 扫描每个分类
  categoryDirs.forEach(dirName => {
    const categoryKey = dirName.substring(1); // 移除开头的 _
    const categoryPath = path.join(CONFIG.categoriesDir, dirName);
    
    console.log(`扫描分类: ${categoryKey}`);
    
    // 获取分类名称
    let categoryName = getCategoryName(categoryPath);
    if (!categoryName) {
      categoryName = CONFIG.categoryNames[categoryKey] || categoryKey;
    }
    
    // 扫描分类目录
    const { images, subCategories } = scanCategory(categoryPath, categoryKey);
    
    index.categories[categoryKey] = {
      name: categoryName,
      images: images,
      subCategories: subCategories
    };
    
    index.stats.totalImages += images.length;
    index.stats.totalCategories++;
    
    console.log(`  - 找到 ${images.length} 张图片`);
    if (subCategories.length > 0) {
      console.log(`  - 子分类: ${subCategories.join(', ')}`);
    }
  });
  
  // 确保输出目录存在
  const outputDir = path.dirname(CONFIG.outputFile);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // 写入 JSON 文件
  fs.writeFileSync(
    CONFIG.outputFile,
    JSON.stringify(index, null, 2),
    'utf-8'
  );
  
  console.log('\n生成完成！');
  console.log(`总图片数: ${index.stats.totalImages}`);
  console.log(`总分类数: ${index.stats.totalCategories}`);
  console.log(`输出文件: ${CONFIG.outputFile}`);
  
  return index;
}

// 运行脚本
if (require.main === module) {
  generateIndex();
}

module.exports = { generateIndex, parseFrontMatter };
