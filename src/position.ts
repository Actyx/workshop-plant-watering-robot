import type { Pos } from './types'

/**
 * A position in the 2D space.
 */
export class Position {
  constructor(readonly x: number, readonly y: number) {}

  static fromPos(pos: Pos) {
    return new Position(pos.x, pos.y);
  }

  static random() {
    return new Position(Math.random() * 1000, Math.random() * 1000);
  }

  direction(other: Position) {
    const x = other.x - this.x;
    const y = other.y - this.y;
    return new Vec(x, y);
  }

  add(vec: Vec) {
    return new Position(this.x + vec.x, this.y + vec.y);
  }

  toString() {
    return `(${this.x.toFixed(0)}, ${this.y.toFixed(0)})`;
  }
}

/**
 * A 2D vector.
 */
export class Vec {
  constructor(public x: number, public y: number) {}

  add(other: Vec) {
    return new Vec(this.x + other.x, this.y + other.y);
  }

  scale(factor: number) {
    return new Vec(this.x * factor, this.y * factor);
  }

  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  normalize() {
    // normalizing the zero vector will result in the zero vector
    const len = Math.max(0.1, this.length());
    return new Vec(this.x / len, this.y / len);
  }
}