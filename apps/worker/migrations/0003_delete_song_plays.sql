-- performances restricts song deletion. Deleting a song takes its plays with
-- it inside the same statement, so a guarded delete that matches no row
-- touches no plays and D1 never commits half of it.
CREATE TRIGGER IF NOT EXISTS songs_delete_performances BEFORE DELETE ON songs
BEGIN
  DELETE FROM performances WHERE song_id = OLD.id;
END;
