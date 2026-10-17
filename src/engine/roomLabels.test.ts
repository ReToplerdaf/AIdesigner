import { describe, expect, it } from 'vitest';
import { areaOf, dictWord, readLabel, type OcrWord } from './roomLabels';

const w = (text: string, line: number, x = 0, conf = 90): OcrWord => ({ text, conf, line, box: { x, y: line * 30, w: 50, h: 20 } });

describe('подписи помещений с плана', () => {
  it('исправляет ошибки распознавания в названиях', () => {
    expect(dictWord('Гостиная')).toBe('Гостиная');
    expect(dictWord('Гоcтиная')).toBe('Гостиная'); // латинская c
    expect(dictWord('Спапьня')).toBe('Спальня');
    expect(dictWord('С/у')).toBe('С/у');
    expect(dictWord('Кух.')).toBe('Кухня');
    expect(dictWord('Мама')).toBeNull();
  });

  it('читает площадь, в том числе с испорченным «м²»', () => {
    expect(areaOf('17,8')).toBe(17.8);
    expect(areaOf('8.3')).toBe(8.3);
    expect(areaOf('12', 'м2')).toBe(12);
    expect(areaOf('12')).toBeNull(); // номер помещения, а не площадь
    expect(areaOf('2,9м?')).toBe(2.9);
    expect(areaOf('1О,2')).toBe(10.2); // буква О вместо нуля
    expect(areaOf('са17,8')).toBe(17.8); // обрывок соседней подписи
  });

  it('собирает название, тип и площадь из слов', () => {
    const l = readLabel([w('Жилая', 0), w('комната', 0, 60), w('14,2', 1), w('м?', 1, 60)]);
    expect(l.name?.text).toBe('Жилая комната');
    expect(l.name?.type).toBe('living');
    expect(l.area?.m2).toBe(14.2);
    expect(l.area?.box.w).toBe(110);
    const wc = readLabel([w('С/у', 0), w('2,8', 1)]);
    expect(wc.name).toMatchObject({ text: 'С/у', type: 'wc' });
  });

  it('отбрасывает неуверенный мусор', () => {
    expect(readLabel([w('ЖЖ', 0, 0, 20), w('3,1', 1, 0, 30)])).toEqual({});
  });
});
