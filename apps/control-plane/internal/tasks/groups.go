package tasks

import (
	"context"

	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

func setGroup(ctx context.Context, tx pgx.Tx, taskID, groupID string) error {
	var id *string
	if groupID != "" {
		parsed, ok := pg.ParseID(groupID)
		if !ok {
			return invalid("没有这个群。")
		}
		ok, err := pg.Exists(ctx, tx, `SELECT 1 FROM chat_group WHERE id=$1 AND NOT archived`, parsed)
		if err != nil {
			return err
		}
		if !ok {
			return invalid("群不存在或已经归档。")
		}
		id = &parsed
	}
	_, err := tx.Exec(ctx, `UPDATE task SET group_id=$2 WHERE id=$1`, taskID, id)
	return err
}

func (s *Service) LinkGroup(ctx context.Context, tx pgx.Tx, ref, groupID string) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	if err = setGroup(ctx, tx, r.ID, groupID); err != nil {
		return nil, err
	}
	if err = record(ctx, tx, r.ID, nil, "group", User, nil, map[string]any{"to": groupID}); err != nil {
		return nil, err
	}
	return s.Get(ctx, tx, r.ID)
}
