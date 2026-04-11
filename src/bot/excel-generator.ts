import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { AdData, ImageTask } from '../types';
import logger from '../utils/logger';

// 引入 image-size 来读取图片原始尺寸
const sizeOf = require('image-size');

export class ExcelGenerator {
  public async generateExcel(tasks: ImageTask[]): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    
    // Sheet 1: Summary Data
    const summarySheet = workbook.addWorksheet('汇总数据');
    summarySheet.columns = [
      { header: '名称', key: 'name', width: 20 },
      { header: '总消耗', key: 'cost', width: 15 },
      { header: '总展示', key: 'impressions', width: 15 },
      { header: '总点击', key: 'clicks', width: 15 }
    ];

    // 美化汇总表表头，居中显示
    const summaryHeader = summarySheet.getRow(1);
    summaryHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    summaryHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F81BD' } // 蓝色背景
    };
    summaryHeader.alignment = { vertical: 'middle', horizontal: 'center' };

    // 设置列数字格式及居中
    summarySheet.getColumn('name').alignment = { vertical: 'middle', horizontal: 'center' };
    summarySheet.getColumn('cost').numFmt = '#,##0.00';
    summarySheet.getColumn('cost').alignment = { vertical: 'middle', horizontal: 'center' };
    summarySheet.getColumn('impressions').numFmt = '#,##0';
    summarySheet.getColumn('impressions').alignment = { vertical: 'middle', horizontal: 'center' };
    summarySheet.getColumn('clicks').numFmt = '#,##0';
    summarySheet.getColumn('clicks').alignment = { vertical: 'middle', horizontal: 'center' };

    const summaryMap: { [key: string]: AdData } = {};
    tasks.forEach(task => {
      if (task.result) {
        task.result.forEach(item => {
          if (!summaryMap[item.名称]) {
            summaryMap[item.名称] = { 名称: item.名称, 消耗: 0, 展示: 0, 点击: 0 };
          }
          summaryMap[item.名称].消耗 += Number(item.消耗) || 0;
          summaryMap[item.名称].展示 += Number(item.展示) || 0;
          summaryMap[item.名称].点击 += Number(item.点击) || 0;
        });
      }
    });

    const summaryList = Object.values(summaryMap).sort((a, b) => a.名称.localeCompare(b.名称));
    summaryList.forEach(item => {
      summarySheet.addRow({
        name: item.名称,
        cost: item.消耗.toFixed(2),
        impressions: item.展示,
        clicks: item.点击
      });
    });

    // Sheet 2: Detail Data
    const detailSheet = workbook.addWorksheet('明细数据');
    detailSheet.columns = [
      { header: '第几张', key: 'index', width: 10 },
      { header: '图片名称', key: 'filename', width: 20 },
      { header: '截图', key: 'image', width: 40 }, // 初始宽度，后面会动态调整
      { header: '识别结果', key: 'result', width: 60 }
    ];

    // 美化明细表表头，居中显示
    const detailHeader = detailSheet.getRow(1);
    detailHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    detailHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F81BD' } // 蓝色背景
    };
    detailHeader.alignment = { vertical: 'middle', horizontal: 'center' };

    // 设置所有列居中
    detailSheet.getColumn('index').alignment = { vertical: 'middle', horizontal: 'center' };
    detailSheet.getColumn('filename').alignment = { vertical: 'middle', horizontal: 'center' };
    detailSheet.getColumn('image').alignment = { vertical: 'middle', horizontal: 'center' };
    detailSheet.getColumn('result').alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

    let maxImageWidth = 0;

    tasks.forEach((task, idx) => {
      const rowIndex = idx + 2; // header is row 1
      const filename = path.basename(task.localPath || `unknown_${task.message_id}.jpg`);
      
      let resultText = "识别失败或无有效数据";
      if (task.result && task.result.length > 0) {
        resultText = "名称 | 总消耗 | 总展示 | 总点击\n--------------------------------\n";
        task.result.forEach(r => {
          resultText += `${r.名称} | ${r.消耗} | ${r.展示} | ${r.点击}\n`;
        });
      }
      
      const row = detailSheet.addRow({
        index: idx + 1,
        filename: filename,
        image: '',
        result: resultText
      });

      let imgWidth = 200;
      let imgHeight = 180;
      let rowHeightPoints = 150;

      if (task.localPath && fs.existsSync(task.localPath)) {
        try {
          // 读取图片真实宽高
          const dimensions = sizeOf(task.localPath);
          if (dimensions.width && dimensions.height) {
            // Excel 单行最大高度为 409 磅（约 546 像素）
            const maxRowHeightPoints = 409;
            const maxRowHeightPx = maxRowHeightPoints / 0.75; // 545.33px
            
            let finalWidthPx = dimensions.width;
            let finalHeightPx = dimensions.height;
            
            // 如果图片高度超过 Excel 允许的单行最大高度，则等比例缩放
            if (finalHeightPx > maxRowHeightPx) {
              const ratio = maxRowHeightPx / finalHeightPx;
              finalHeightPx = maxRowHeightPx;
              finalWidthPx = finalWidthPx * ratio;
            }
            
            imgWidth = finalWidthPx;
            imgHeight = finalHeightPx;
            rowHeightPoints = finalHeightPx * 0.75; // px 转 points
            
            if (imgWidth > maxImageWidth) {
              maxImageWidth = imgWidth;
            }
          }
          
          const imageId = workbook.addImage({
            buffer: fs.readFileSync(task.localPath) as any,
            extension: 'jpeg'
          });
          
          detailSheet.addImage(imageId, {
            tl: { col: 2, row: rowIndex - 1 },
            ext: { width: imgWidth, height: imgHeight },
            editAs: 'oneCell'
          });
        } catch (e) {
          logger.error(`Error adding image to excel for task ${task.message_id}`, e);
        }
      }

      row.height = rowHeightPoints; // 根据图片高度设置行高
    });

    // 动态调整第三列（截图列）的宽度
    // Excel 列宽 1 个单位约为 7.5 像素，为了留点边距加上 2 个单位
    if (maxImageWidth > 0) {
      detailSheet.getColumn('image').width = Math.ceil(maxImageWidth / 7.5) + 2;
    }

    // 使用中国时间生成文件名：report_日期_中国时间
    // 这里获取东八区时间，格式为 YYYY-MM-DD_HH-mm-ss
    const now = new Date();
    const chinaTime = new Date(now.getTime() + 8 * 3600 * 1000);
    const timeStr = chinaTime.toISOString().replace('T', '_').replace(/:/g, '-').split('.')[0];
    
    const outputPath = path.join(__dirname, '../../temp', `report_${timeStr}.xlsx`);
    if (!fs.existsSync(path.dirname(outputPath))) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }
    
    await workbook.xlsx.writeFile(outputPath);
    logger.info(`Excel generated at ${outputPath}`);
    
    return outputPath;
  }
}
