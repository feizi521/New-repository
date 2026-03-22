const fs = require('fs');
const path = require('path');

const categories = ['avatar', 'wallpaper', 'people', 'scenery', 'wei-mei-zhi-yu', 'dong-man-cha-hua', 'wen-zi-yu-lu', 'ying-shi-ming-xing', 'bei-jing-su-cai'];

const categoryNames = {
  'wallpaper': '高清壁纸',
  'avatar': '个性头像',
  'people': '人物',
  'scenery': '风景',
  'wei-mei-zhi-yu': '唯美治愈',
  'dong-man-cha-hua': '动漫插画',
  'wen-zi-yu-lu': '文字语录',
  'ying-shi-ming-xing': '影视明星',
  'bei-jing-su-cai': '背景素材'
};

function parseMarkdown(content, filePath) {
  const yamlMatch = content.match(/---([\s\S]*?)---/);
  if (yamlMatch) {
    const lines = yamlMatch[1].trim().split('\n');
    const imageInfo = {};
    
    lines.forEach(line => {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
        imageInfo[key] = value;
      }
    });
    
    if (imageInfo.image) {
      // 解析标签，支持逗号分隔的多个标签
      let tags = [];
      if (imageInfo.tags) {
        tags = imageInfo.tags.split(',').map(tag => tag.trim()).filter(tag => tag);
      }
      
      // 生成唯一ID（基于文件名或时间戳）
      const id = path.basename(filePath, '.md');
      
      return {
        id: id,
        title: imageInfo.title || '无标题',
        category: imageInfo.category || '未分类',
        tags: tags,
        image: imageInfo.image
      };
    }
  }
  return null;
}

function getSubCategoryName(folderPath) {
  const readmePath = path.join(folderPath, 'README.md');
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, 'utf-8');
    const match = content.match(/^#\s*(.+)$/m);
    if (match) return match[1].trim();
  }
  return null;
}

function scanDirectory(dir, parentSubCategoryName = null) {
  const results = [];
  
  if (!fs.existsSync(dir)) return results;
  
  const items = fs.readdirSync(dir);
  
  // Check for README.md to get subcategory name for current folder
  const folderSubCategory = getSubCategoryName(dir);
  // Use current folder's subcategory if available, otherwise inherit from parent
  const currentSubCategory = folderSubCategory || parentSubCategoryName;
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Pass current folder's subcategory to subfolders (they can override with their own README)
      results.push(...scanDirectory(fullPath, currentSubCategory));
    } else if (item.endsWith('.md') && item.toLowerCase() !== 'readme.md') {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const imageInfo = parseMarkdown(content, fullPath);
          if (imageInfo) {
            // Priority: 1. YAML category, 2. Folder README subcategory, 3. Parent subcategory
            // Only override YAML category if folder has its own README.md (explicit subcategory)
            if (folderSubCategory && !imageInfo.category) {
              imageInfo.category = folderSubCategory;
            } else if (!imageInfo.category && currentSubCategory) {
              imageInfo.category = currentSubCategory;
            }
            results.push(imageInfo);
          }
        }
  }
  
  return results;
}

console.log('Generating image index...\n');

const imageData = {};
let totalImages = 0;

for (const category of categories) {
  const categoryPath = path.join(__dirname, '..', `_${category}`);
  console.log(`Scanning ${category}...`);
  
  const images = scanDirectory(categoryPath);
  imageData[category] = images;
  totalImages += images.length;
  
  console.log(`  Found ${images.length} images`);
}

const output = {
  version: '1.0',
  generatedAt: new Date().toISOString(),
  categoryNames,
  imageData
};

const outputPath = path.join(__dirname, '..', 'data', 'image-index.json');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(outputPath))) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
}

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

console.log(`\n✅ Index generated successfully!`);
console.log(`   Total images: ${totalImages}`);
console.log(`   Output: ${outputPath}`);
