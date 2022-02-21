.PHONY: up run tag

up:
	git add .
	git commit -am "update"
	git pull origin main
	git push origin main
	@echo "\n 代码提交发布..."

run:
	go run main.go

tag:
	git pull origin main
	git add .
	git commit -am "update"
	git push origin main
	git tag v1.0.1
	git push --tags
	@echo "\n tags 发布中..."
