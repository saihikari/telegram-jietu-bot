import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { AdData, ImageTask } from '../types';
import logger from '../utils/logger';

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
      { header: '截图', key: 'image', width: 30 },
      { header: '识别结果', key: 'result', width: 40 }
    ];

    tasks.forEach((task, idx) => {
      const rowIndex = idx + 2; // header is row 1
      const filename = path.basename(task.localPath || `unknown_${task.message_id}.jpg`);
      
      let resultText = "识别失败或无有效数据";
      if (task.result && task.result.length > 0) {
        resultText = "名称 总消耗 总展示 总点击\n";
        task.result.forEach(r => {
          resultText += `${r.名称} ${r.消耗} ${r.展示} ${r.点击}\n`;
        });
      }
      
      const row = detailSheet.addRow({
        index: idx + 1,
        filename: filename,
        image: '',
        result: resultText
      });

      row.height = 150; // set a fixed row height to fit image
      row.getCell('result').alignment = { wrapText: true, vertical: 'top' };

      if (task.localPath && fs.existsSync(task.localPath)) {
        try {
          const imageId = workbook.addImage({
            buffer: fs.readFileSync(task.localPath) as any,
            extension: 'jpeg'
          });
          
          detailSheet.addImage(imageId, {
            tl: { col: 2, row: rowIndex - 1 },
            ext: { width: 200, height: 180 },
            editAs: 'oneCell'
          });
        } catch (e) {
          logger.error(`Error adding image to excel for task ${task.message_id}`, e);
        }
      }
    });

    const outputPath = path.join(__dirname, '../../temp', `report_${Date.now()}.xlsx`);
    if (!fs.existsSync(path.dirname(outputPath))) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }
    
    await workbook.xlsx.writeFile(outputPath);
    logger.info(`Excel generated at ${outputPath}`);
    
    return outputPath;
  }
}
