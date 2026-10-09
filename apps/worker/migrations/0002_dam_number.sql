-- DAM karaoke numbers ("1472-59"). One DAM number belongs to at most one song.
ALTER TABLE songs ADD COLUMN dam_number TEXT CHECK (dam_number IS NULL OR dam_number GLOB '[0-9]*-[0-9][0-9]');
CREATE UNIQUE INDEX IF NOT EXISTS songs_dam_number_idx ON songs(dam_number);
