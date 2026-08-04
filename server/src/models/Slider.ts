import mongoose, { Document, Schema } from 'mongoose';

export interface ISlider extends Document {
    name: string;
    image: string;
    link?: string;
    sortOrder: number;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const SliderSchema: Schema = new Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    image: { type: String, required: true, trim: true, maxlength: 2048 },
    link: { type: String, default: '', trim: true, maxlength: 2048 },
    sortOrder: { type: Number, default: 0, min: 0 },
    status: { type: Boolean, default: true },
}, {
    timestamps: true
});

SliderSchema.index({ sortOrder: 1 });
SliderSchema.index({ status: 1 });

export default mongoose.model<ISlider>('Slider', SliderSchema);
