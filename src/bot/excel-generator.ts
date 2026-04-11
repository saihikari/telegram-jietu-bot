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
    // 设置默认列宽为 12（大约能够显示10位数字，约 84 像素宽）
    detailSheet.properties.defaultColWidth = 12;

    let currentRow = 1;

    tasks.forEach((task, idx) => {
      // 1. 第 x 张 - [文字] - 截图及识别结果
      const titleRow = detailSheet.getRow(currentRow);
      const captionText = task.caption ? ` - [${task.caption}]` : '';
      titleRow.getCell(1).value = `第${idx + 1}张${captionText} - 截图及识别结果`;
      titleRow.getCell(1).font = { bold: true, size: 12 };
      detailSheet.mergeCells(currentRow, 1, currentRow, 10);
      currentRow++;

      // 2. 插入图片，并计算图片跨多少行
      let imgWidth = 200;
      let imgHeight = 180;
      let spannedRows = 10;

      if (task.localPath && fs.existsSync(task.localPath)) {
        try {
          const dimensions = sizeOf(task.localPath);
          if (dimensions.width && dimensions.height) {
            // 10列的宽度约为 840 像素
            const maxWidthPx = 840;
            let finalWidthPx = dimensions.width;
            let finalHeightPx = dimensions.height;

            // 如果图片宽度超过 10 列的像素宽度，等比例缩小
            if (finalWidthPx > maxWidthPx) {
              const ratio = maxWidthPx / finalWidthPx;
              finalWidthPx = maxWidthPx;
              finalHeightPx = finalHeightPx * ratio;
            }

            imgWidth = finalWidthPx;
            imgHeight = finalHeightPx;
          }

          const imageId = workbook.addImage({
            buffer: fs.readFileSync(task.localPath) as any,
            extension: 'jpeg'
          });

          // 插入图片
          detailSheet.addImage(imageId, {
            tl: { col: 0, row: currentRow - 1 }, // 放置在A列，当前行
            ext: { width: imgWidth, height: imgHeight },
            editAs: 'oneCell'
          });

          // 计算图片跨过的行数。默认行高约为 15 磅（20 像素）。
          // 给图片留一点边距，加 1 行
          spannedRows = Math.ceil(imgHeight / 20) + 1;
        } catch (e) {
          logger.error(`Error adding image to excel for task ${task.message_id}`, e);
        }
      }

      // 跳过图片占据的行数
      currentRow += spannedRows;

      // 3. 打印识别结果表头
      const headerRow = detailSheet.getRow(currentRow);
      headerRow.values = ['名称', '消耗', '展示', '点击'];
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      for (let i = 1; i <= 4; i++) {
        headerRow.getCell(i).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF4F81BD' } // 蓝色背景
        };
      }
      currentRow++;

      // 4. 打印识别结果数据
      if (task.result && task.result.length > 0) {
        task.result.forEach(r => {
          const dataRow = detailSheet.getRow(currentRow);
          dataRow.getCell(1).value = r.名称;
          dataRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
          
          dataRow.getCell(2).value = Number(r.消耗) || 0;
          dataRow.getCell(2).numFmt = '#,##0.00';
          dataRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
          
          dataRow.getCell(3).value = Number(r.展示) || 0;
          dataRow.getCell(3).numFmt = '#,##0';
          dataRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
          
          dataRow.getCell(4).value = Number(r.点击) || 0;
          dataRow.getCell(4).numFmt = '#,##0';
          dataRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
          
          currentRow++;
        });
      } else {
        const noDataRow = detailSheet.getRow(currentRow);
        noDataRow.getCell(1).value = '识别失败或无有效数据';
        detailSheet.mergeCells(currentRow, 1, currentRow, 4);
        noDataRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
        currentRow++;
      }

      // 5. 留一个空行给下一张图片
      currentRow++;
    });

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
